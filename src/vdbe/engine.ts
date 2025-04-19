import { StatusCode, type SqlValue, SqlDataType } from '../common/types';
import { SqliteError, MisuseError, ConstraintError } from '../common/errors';
import type { Database } from '../core/database';
import type { Statement } from '../core/statement';
import type { VdbeProgram } from './program';
import type { VdbeInstruction, P4Vtab, P4FuncDef } from './instruction';
import { Opcode, ConflictResolution } from '../common/constants';
import { evaluateIsTrue, compareSqlValues } from '../util/comparison';
import type { VirtualTableCursor } from '../vtab/cursor';
import type { VirtualTable } from '../vtab/table';
import { FunctionContext } from '../func/context';
import type { TableSchema } from '../schema/table';

/** Represents a single VDBE memory cell (register) */
export interface MemoryCell {
    value: SqlValue;
    // TODO: Add flags like type, subtype if needed
}

/** Internal state for a VDBE cursor */
interface VdbeCursor {
    instance: VirtualTableCursor<any> | null; // The actual VTable cursor
    vtab: VirtualTable | null; // The VTable instance (useful for module access)
    isValid: boolean;          // Is the cursor pointing to a valid row?
    isEof: boolean;            // Has EOF been reached?
}

/**
 * Represents an execution instance of a VDBE program.
 * This is the virtual machine that runs the bytecode.
 */
export class Vdbe {
    private readonly db: Database;
    private readonly program: VdbeProgram;
    private readonly stmt: Statement; // Statement this VDBE belongs to

    private programCounter: number = 0;
    private memoryCells: MemoryCell[];
    private stack: SqlValue[] = []; // Simpler stack storing just values for now
    private cursors: VdbeCursor[]; // Holds state for open cursors
    private hasYielded = false;
    private done = false;
    private error: SqliteError | null = null;
    private appliedBindings: boolean = false;
    private vtabContext: FunctionContext; // Context used for vtab xColumn calls
    private udfContext: FunctionContext; // Context for User Defined Functions

    constructor(stmt: Statement, program: VdbeProgram) {
        this.stmt = stmt;
        this.db = stmt.db;
        this.program = program;
        this.memoryCells = new Array(program.numMemCells).fill(null).map(() => ({ value: null }));
        this.cursors = new Array(program.numCursors).fill(null).map(() => ({
            instance: null,
            vtab: null,
            isValid: false,
            isEof: false,
        }));
        this.vtabContext = new FunctionContext(this.db);
        this.udfContext = new FunctionContext(this.db); // Create context for UDFs
    }

    /** Apply bound parameters to memory cells (Placeholder) */
    applyBindings(bindings: Map<number | string, SqlValue>): void {
        if (this.appliedBindings) return; // Apply only once per run cycle unless reset
        console.log("VDBE applying bindings (placeholder)...");
        // TODO: Map parameter names/indices (from program.parameters) to memory cell indices
        // and set the values in this.memoryCells. This requires the compiler
        // to generate the program.parameters map correctly.
        bindings.forEach((value, key) => {
            // Placeholder: assume param index maps directly to mem cell index + 1 (since SQLite params are 1-based)
            const paramInfo = typeof key === 'number' ? this.program.parameters.get(key) : this.program.parameters.get(key);
            const memIdx = paramInfo?.memIdx; // Assuming compiler stored the target mem cell index here
             if (memIdx !== undefined && memIdx >= 0) { // Use 0-based index for memoryCells array
                this._setMem(memIdx, value);
             } else {
                 console.warn(`Could not map parameter ${key} to memory cell`);
             }
        });
        this.appliedBindings = true;
    }

    /** Clear flag indicating bindings need reapplication */
    clearAppliedBindings(): void {
        this.appliedBindings = false;
        // Optionally clear the memory cells holding bound values too
    }

    /** Resets the VDBE to its initial state for re-execution */
    async reset(): Promise<void> {
        this.programCounter = 0;
        this.stack = [];
        this.memoryCells.forEach(cell => cell.value = null);
        this.appliedBindings = false;
        this.hasYielded = false;
        this.done = false;
        this.error = null;

        this.udfContext._clear(); // Clear UDF context state
        this.udfContext._cleanupAuxData(); // Clean up UDF aux data

        // Close open cursors
        const closePromises: Promise<void>[] = [];
        for (let i = 0; i < this.cursors.length; i++) {
            const cursor = this.cursors[i];
            if (cursor.instance && cursor.vtab) {
                closePromises.push(cursor.vtab.module.xClose(cursor.instance));
                this.cursors[i] = { instance: null, vtab: null, isValid: false, isEof: false }; // Reset state
            }
        }
        await Promise.allSettled(closePromises); // Wait for closures, ignore errors for now
    }

    /** Executes the VDBE program until it yields, completes, or errors */
    async run(): Promise<StatusCode> {
        if (this.done || this.error) {
             return this.error ? this.error.code : StatusCode.MISUSE;
        }
        this.hasYielded = false;

        try {
            // Apply bindings if needed
            if (!this.appliedBindings) {
                this.applyBindings(new Map());
            }

            while (!this.done && !this.hasYielded && !this.error) {
                const instruction = this.program.instructions[this.programCounter];
                if (!instruction) {
                    this.error = new SqliteError(`Invalid program counter: ${this.programCounter}`, StatusCode.INTERNAL);
                    break;
                }

                 console.debug(`VDBE Exec: [${this.programCounter}] ${Opcode[instruction.opcode]} ${instruction.p1} ${instruction.p2} ${instruction.p3} ${instruction.p4 !== null ? `P4:${String(instruction.p4)}` : ''} ${instruction.comment ? `-- ${instruction.comment}` : ''}`);

                await this.executeInstruction(instruction);

                // Check if instruction handled PC, otherwise increment
                if (!this.error && !this.done && !this.hasYielded && this.programCounter < this.program.instructions.length && this.program.instructions[this.programCounter] === instruction) {
                     this.programCounter++;
                }
            }
        } catch (e) {
             console.error("VDBE Execution Error:", e);
            if (e instanceof SqliteError) {
                this.error = e;
            } else if (e instanceof Error) {
                this.error = new SqliteError(`Runtime error: ${e.message}`, StatusCode.ERROR);
            } else {
                 this.error = new SqliteError("Unknown runtime error", StatusCode.INTERNAL);
            }
            this.done = true;
        }

        if (this.error) return this.error.code;
        if (this.hasYielded) return StatusCode.ROW;
        if (this.done) return StatusCode.DONE;

        return StatusCode.INTERNAL;
    }

    /** Executes a single VDBE instruction */
    private async executeInstruction(inst: VdbeInstruction): Promise<void> {
        const p1 = inst.p1;
        const p2 = inst.p2;
        const p3 = inst.p3;
        const p4 = inst.p4;

        // Helper to get value from register or constant pool
        const getValue = (regOrConstIdx: number, isConst: boolean): SqlValue => {
            if (isConst) {
                if (regOrConstIdx < 0 || regOrConstIdx >= this.program.constants.length) {
                    throw new SqliteError(`Invalid constant index: ${regOrConstIdx}`, StatusCode.INTERNAL);
                }
                return this.program.constants[regOrConstIdx];
            } else {
                 return this._getMemValue(regOrConstIdx);
            }
        };

        // Helper for conditional jumps
        const conditionalJump = (result: boolean) => {
            if (result) {
                this.programCounter = p2; // Jump to P2 on true
            } else {
                this.programCounter++; // Continue to next instruction on false
            }
        };


        switch (inst.opcode) {
            case Opcode.Init:
                this.programCounter = p2; return;
            case Opcode.Goto:
                 this.programCounter = p2; return;

            case Opcode.Integer: // P1=value, P2=reg
                this._setMem(p2, p1); break;
            case Opcode.Int64: // P2=reg, P4=const_idx
                 this._setMem(p2, getValue(p4 as number, true)); break;
            case Opcode.String8: // P2=reg, P4=const_idx
                 this._setMem(p2, getValue(p4 as number, true)); break;
            case Opcode.Null: // P2=reg
                 this._setMem(p2, null); break;
            case Opcode.SCopy: // P1=src_reg, P2=dest_reg
                 this._setMem(p2, this._getMemValue(p1)); break;

            // --- Comparisons ---
            // P1=regLeft, P2=addrJump, P3=regRight, P4=coll?, P5=flags (Ignore P4/P5 for now)
            // These compare R[P3] against R[P1]
            case Opcode.Eq:
                conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) === 0); return;
            case Opcode.Ne:
                conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) !== 0); return;
            case Opcode.Lt:
                conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) < 0); return;
            case Opcode.Le:
                conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) <= 0); return;
            case Opcode.Gt:
                conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) > 0); return;
            case Opcode.Ge:
                conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) >= 0); return;


            // --- Arithmetic ---
            // P1=regLeft, P2=regRight, P3=regDest
            case Opcode.Add:
                this._binaryArithOp(p1, p2, p3, (a, b) => Number(a) + Number(b)); break;
            case Opcode.Subtract:
                this._binaryArithOp(p1, p2, p3, (a, b) => Number(b) - Number(a)); break; // Note: SQLite subtracts P1 from P2
            case Opcode.Multiply:
                this._binaryArithOp(p1, p2, p3, (a, b) => Number(a) * Number(b)); break;
             // TODO: Add Divide, Remainder - need careful type handling (integer vs float div)

            // --- Control Flow / State ---
            case Opcode.IfTrue:
                conditionalJump(evaluateIsTrue(this._getMemValue(p1))); return;
            case Opcode.IfFalse:
                 conditionalJump(!evaluateIsTrue(this._getMemValue(p1))); return;
            // TODO: Add IfNull, IfNotNull etc.

            case Opcode.ResultRow:
                 this.stmt._setCurrentRow(this.memoryCells.slice(p1, p1 + p2));
                 this.hasYielded = true;
                 this.programCounter++;
                 return;

            case Opcode.Halt:
                 this.done = true;
                 if (p1 !== StatusCode.OK) {
                    const errMsg = typeof p4 === 'string' ? p4 : "Execution halted";
                    this.error = new SqliteError(errMsg, p1);
                 }
                 return;

            case Opcode.Noop:
                 break;

            // --- VTable Opcodes ---
             case Opcode.OpenRead: { // P1=cursorIdx, P2=0, P3=dbIdx, P4=VTab Ptr (actually TableSchema)
                const cursorIdx = p1;
                // P4 should contain the resolved TableSchema by the compiler
                const tableSchema = p4 as TableSchema | undefined;
                if (!tableSchema || !tableSchema.isVirtual || !tableSchema.vtabInstance) {
                    throw new SqliteError("VTable not instantiated for OpenRead", StatusCode.INTERNAL);
                }
                if (cursorIdx < 0 || cursorIdx >= this.cursors.length) {
                     throw new SqliteError(`Invalid cursor index ${cursorIdx} for OpenRead`, StatusCode.INTERNAL);
                }
                // Ensure cursor is closed if already open (shouldn't happen in normal flow?)
                if(this.cursors[cursorIdx].instance) {
                    await this.cursors[cursorIdx].vtab!.module.xClose(this.cursors[cursorIdx].instance!);
                }

                const vtab = tableSchema.vtabInstance;
                const cursorInstance = await vtab.module.xOpen(vtab);
                this.cursors[cursorIdx] = {
                    instance: cursorInstance,
                    vtab: vtab,
                    isValid: false, // Becomes valid after first successful VFilter/VNext
                    isEof: false,
                };
                break; // Let main loop increment PC
            }

            case Opcode.VFilter: { // P1=cursorIdx, P2=addrNoRow, P3=regArgsStart, P4={idxNum, idxStr, nArgs}
                const cursorIdx = p1;
                const vdbeCursor = this.cursors[cursorIdx];
                if (!vdbeCursor?.instance || !vdbeCursor.vtab) {
                    throw new SqliteError(`Invalid cursor ${cursorIdx} for VFilter`, StatusCode.INTERNAL);
                }

                // P4 should contain info set by compiler based on xBestIndex output
                const filterInfo = p4 as { idxNum: number, idxStr: string | null, nArgs: number };
                if (!filterInfo) {
                     throw new SqliteError(`Missing P4 info for VFilter on cursor ${cursorIdx}`, StatusCode.INTERNAL);
                }

                const args: SqlValue[] = [];
                for (let i = 0; i < filterInfo.nArgs; i++) {
                    args.push(this._getMemValue(p3 + i));
                }

                await vdbeCursor.vtab.module.xFilter(vdbeCursor.instance, filterInfo.idxNum, filterInfo.idxStr, args);

                // Check EOF immediately after filter
                const eof = await vdbeCursor.vtab.module.xEof(vdbeCursor.instance);
                vdbeCursor.isEof = eof;
                vdbeCursor.isValid = !eof;

                if (eof) {
                    this.programCounter = p2; // Jump to no-row address
                } else {
                    this.programCounter++; // Continue to next instruction
                }
                return; // PC handled
            }

            case Opcode.VNext: { // P1=cursorIdx, P2=addrEOF
                const cursorIdx = p1;
                const vdbeCursor = this.cursors[cursorIdx];
                if (!vdbeCursor?.instance || !vdbeCursor.vtab) {
                    throw new SqliteError(`Invalid cursor ${cursorIdx} for VNext`, StatusCode.INTERNAL);
                }

                await vdbeCursor.vtab.module.xNext(vdbeCursor.instance);
                const eof = await vdbeCursor.vtab.module.xEof(vdbeCursor.instance);
                vdbeCursor.isEof = eof;
                vdbeCursor.isValid = !eof;

                if (eof) {
                    this.programCounter = p2; // Jump to EOF address
                } else {
                    this.programCounter++; // Continue
                }
                return; // PC handled
            }

            case Opcode.VColumn: { // P1=cursorIdx, P2=colIdx, P3=destReg
                const cursorIdx = p1;
                const colIdx = p2;
                const destReg = p3;
                const vdbeCursor = this.cursors[cursorIdx];

                if (!vdbeCursor?.instance || !vdbeCursor.vtab) {
                    throw new SqliteError(`Invalid cursor ${cursorIdx} for VColumn`, StatusCode.INTERNAL);
                }
                if (!vdbeCursor.isValid) {
                     throw new SqliteError(`VColumn called on invalid cursor ${cursorIdx}`, StatusCode.MISUSE);
                }

                // Use the dedicated context, clearing previous results/errors
                this.vtabContext._clear();

                const status = vdbeCursor.vtab.module.xColumn(vdbeCursor.instance, this.vtabContext, colIdx);

                if (status !== StatusCode.OK) {
                     // Should xColumn throw, or return status? Interface says return status.
                     // If it returns an error status, we reflect that.
                     const errMsg = this.vtabContext._getError()?.message || `VTable xColumn failed with code ${status}`;
                     throw new SqliteError(errMsg, status);
                }

                // Get result from context and store in register
                const resultVal = this.vtabContext._getResult();
                this._setMem(destReg, resultVal);
                break; // Let main loop increment PC
            }

            case Opcode.Function: { // P1=unused?, P2=firstArgReg, P3=resultReg, P4=P4FuncDef
                if (!p4 || typeof p4 !== 'object' || p4.type !== 'funcdef') {
                    throw new SqliteError(`Invalid P4 for Opcode.Function`, StatusCode.INTERNAL);
                }
                const funcInfo = p4 as P4FuncDef;
                const funcDef = funcInfo.funcDef;
                const nArgs = funcInfo.nArgs; // Actual number of args provided
                const firstArgReg = p2;
                const resultReg = p3;

                if (!funcDef.xFunc) {
                     // TODO: Handle Aggregate/Window functions later (needs xStep/xFinal logic)
                    throw new SqliteError(`Aggregate/Window function ${funcDef.name} called with scalar opcode`, StatusCode.ERROR);
                }

                // Gather arguments
                const args: SqlValue[] = [];
                // Check arity
                if (funcDef.numArgs >= 0 && funcDef.numArgs !== nArgs) {
                     throw new SqliteError(`Function ${funcDef.name} called with ${nArgs} arguments, expected ${funcDef.numArgs}`, StatusCode.ERROR);
                } else if (funcDef.numArgs < 0 && nArgs > Math.abs(funcDef.numArgs)) {
                    // Handle varargs limit if -N represents max args
                    // For now, assume -1 means any number, check sqlite3_limit later if needed
                }

                for (let i = 0; i < nArgs; i++) {
                    args.push(this._getMemValue(firstArgReg + i));
                }

                // Prepare context
                // Reuse context, pass correct user data
                this.udfContext = new FunctionContext(this.db, funcDef.userData);
                this.udfContext._clear(); // Clear previous results/errors

                try {
                    // Invoke the scalar function
                    funcDef.xFunc(this.udfContext, Object.freeze(args)); // Pass immutable args

                    // Process result/error from context
                    const error = this.udfContext._getError();
                    if (error) {
                        throw error; // Propagate error thrown by function
                    }
                    const result = this.udfContext._getResult();
                    this._setMem(resultReg, result);
                    // TODO: Handle subtype if set via context.resultSubtype()
                } catch (e) {
                    // Catch errors thrown directly by the JS function
                    if (e instanceof SqliteError) { throw e; }
                    if (e instanceof Error) { throw new SqliteError(`Error in function ${funcDef.name}: ${e.message}`, StatusCode.ERROR); }
                    throw new SqliteError(`Unknown error in function ${funcDef.name}`, StatusCode.ERROR);
                }
                // Note: Aux data cleanup happens in reset/finalize, not after every call
                break; // Let main loop increment PC
            }

            // --- New Opcodes ---
            case Opcode.Real: // P2=reg, P4=const_idx
                 this._setMem(p2, getValue(p4 as number, true)); break;
            case Opcode.Blob: // P1=len?, P2=reg, P4=const_idx
                 // P1 often holds length, but for constants we get it from the value
                 this._setMem(p2, getValue(p4 as number, true)); break;
            case Opcode.ZeroBlob: // P1=reg_size, P2=reg_dest
                 const size = Number(this._getMemValue(p1)); // Coerce size to number
                 this._setMem(p2, new Uint8Array(size >= 0 ? Math.trunc(size) : 0));
                 break;

            case Opcode.Move: // P1=src, P2=dest, P3=count
                 if (p1 + p3 > this.memoryCells.length || p2 + p3 > this.memoryCells.length || p1<0 || p2<0 || p3<0) {
                     throw new SqliteError("Move opcode out of bounds", StatusCode.INTERNAL);
                 }
                 if (p1 === p2) break; // No-op
                 if (p2 > p1 && p2 < p1 + p3) { // Overlap, copy backwards
                     for(let i = p3 - 1; i >= 0; i--) {
                         this._setMem(p2 + i, this._getMemValue(p1 + i));
                     }
                 } else { // No overlap or copy forwards is safe
                     for(let i = 0; i < p3; i++) {
                         this._setMem(p2 + i, this._getMemValue(p1 + i));
                     }
                 }
                 break;

            case Opcode.Clear: // P1=start_reg, P2=count
                const endReg = p1 + p2;
                if (p1 < 0 || endReg > this.memoryCells.length) {
                     throw new SqliteError("Clear opcode out of bounds", StatusCode.INTERNAL);
                }
                for (let i = p1; i < endReg; i++) {
                    this._setMem(i, null);
                }
                break;

            case Opcode.IfNull: // P1=reg, P2=addr
                 conditionalJump(this._getMemValue(p1) === null); return;
            case Opcode.IfNotNull: // P1=reg, P2=addr
                 conditionalJump(this._getMemValue(p1) !== null); return;
            case Opcode.IsNull: // P1=reg, P2=dest
                 this._setMem(p2, this._getMemValue(p1) === null); break;
            case Opcode.NotNull: // P1=reg, P2=dest
                 this._setMem(p2, this._getMemValue(p1) !== null); break;

            case Opcode.Divide: // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P2] / R[P1]
                 const divisor = this._getMemValue(p1);
                 const dividend = this._getMemValue(p2);
                 if (divisor === null || dividend === null) {
                     this._setMem(p3, null);
                 } else {
                     const nDivisor = Number(divisor);
                     const nDividend = Number(dividend);
                     if (nDivisor === 0) {
                         this._setMem(p3, null); // Division by zero -> NULL
                     } else if (isNaN(nDivisor) || isNaN(nDividend)) {
                         this._setMem(p3, null); // NaN input -> NULL
                     } else {
                         this._setMem(p3, nDividend / nDivisor); // Float division
                     }
                 }
                 break;

             case Opcode.Remainder: // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P2] % R[P1]
                 const rem_r1 = this._getMemValue(p1);
                 const rem_r2 = this._getMemValue(p2);
                 if (rem_r1 === null || rem_r2 === null) {
                     this._setMem(p3, null);
                 } else {
                     // Prioritize BigInt if either operand is BigInt
                     if (typeof rem_r1 === 'bigint' || typeof rem_r2 === 'bigint') {
                         try {
                             const b1 = BigInt(rem_r1 as any); // Coerce potential number
                             const b2 = BigInt(rem_r2 as any);
                             if (b1 === 0n) {
                                 this._setMem(p3, null); // Modulo by zero
                             } else {
                                 this._setMem(p3, b2 % b1);
                             }
                         } catch {
                             this._setMem(p3, null); // Coercion failed
                         }
                     } else { // Both are likely numbers or string coercible to numbers
                         const n1 = Number(rem_r1);
                         const n2 = Number(rem_r2);
                         if (n1 === 0 || isNaN(n1) || isNaN(n2)) {
                             this._setMem(p3, null); // Modulo by zero or NaN is NULL
                         } else {
                             this._setMem(p3, n2 % n1);
                         }
                     }
                 }
                 break;

            case Opcode.Concat: // P1=firstReg, P2=lastReg, P3=destReg
                 let result = '';
                 for (let i = p1; i <= p2; i++) {
                     const val = this._getMemValue(i);
                     if (val !== null && val !== undefined) {
                         // SQLite string concat coerces BLOBs to empty string
                         if (val instanceof Uint8Array) {
                             // result += ''; // Ignore blobs? Or try UTF8 decode? Ignore for now.
                         } else {
                             result += String(val);
                         }
                     }
                 }
                 this._setMem(p3, result);
                 break;

            case Opcode.Close: // P1=cursorIdx
                const cursorToClose = this.cursors[p1];
                if (cursorToClose?.instance && cursorToClose.vtab) {
                    // console.debug(`Closing cursor ${p1}`);
                    await cursorToClose.vtab.module.xClose(cursorToClose.instance);
                    this.cursors[p1] = { instance: null, vtab: null, isValid: false, isEof: false };
                }
                break;

            case Opcode.Once: // P1=reg_flag, P2=addr_jump
                const flagVal = this._getMemValue(p1);
                if (flagVal === null || flagVal === 0 || flagVal === false) { // Check against known falsey values
                    this._setMem(p1, 1); // Set flag to true (or 1)
                    // Don't jump, execute the 'once' block
                } else {
                    this.programCounter = p2; // Flag was already set, jump past 'once' block
                    return;
                }
                break;

             // --- VTable Write/Transaction Opcodes ---
             case Opcode.OpenWrite: { // P1=cursorIdx, P2=numCols, P3=dbIdx, P4=TableSchema Ptr
                const cursorIdx = p1;
                const tableSchema = p4 as TableSchema | undefined;
                 if (!tableSchema || !tableSchema.isVirtual || !tableSchema.vtabInstance) {
                    throw new SqliteError("VTable not instantiated for OpenWrite", StatusCode.INTERNAL);
                }
                 if (cursorIdx < 0 || cursorIdx >= this.cursors.length) {
                     throw new SqliteError(`Invalid cursor index ${cursorIdx} for OpenWrite`, StatusCode.INTERNAL);
                }
                if(this.cursors[cursorIdx].instance) { await this.cursors[cursorIdx].vtab!.module.xClose(this.cursors[cursorIdx].instance!); }

                const vtab = tableSchema.vtabInstance;
                const cursorInstance = await vtab.module.xOpen(vtab);
                this.cursors[cursorIdx] = { instance: cursorInstance, vtab: vtab, isValid: false, isEof: false };
                break;
             }

             case Opcode.VUpdate: { // P1=nData, P2=regDataStart, P3=regNewRowidDest?, P4={onConflict: ConflictResolution, table: TableSchema}
                 const nData = p1;
                 const regDataStart = p2;
                 const regNewRowidDest = p3; // Register to store new rowid for INSERT
                 const updateInfo = p4 as { onConflict: ConflictResolution, table: TableSchema } | undefined;
                 if (!updateInfo) throw new SqliteError("Missing P4 info for VUpdate", StatusCode.INTERNAL);

                 const vtab = updateInfo.table.vtabInstance;
                 if (!vtab || !vtab.module.xUpdate) {
                     throw new SqliteError(`VTable ${updateInfo.table.name} does not support xUpdate`, StatusCode.ERROR);
                 }

                 // Gather data for xUpdate based on typical VDBE patterns
                 const values: SqlValue[] = [];
                 let rowid: bigint | null = null;
                 let opType: 'INSERT' | 'UPDATE' | 'DELETE';

                // Determine op based on P1 (nData) and content of R[P2] (first value)
                // This relies heavily on the compiler generating code correctly.
                // See sqlite3VdbeExec() in vdbe.c around OP_VUpdate for C logic.
                const firstVal = this._getMemValue(regDataStart);

                if (p1 > 1 && firstVal === null) { // Usually INSERT: R[P2]=NULL, R[P2+1..]=New Values
                    opType = 'INSERT';
                    for (let i = 1; i < nData; i++) { // Skip the initial NULL rowid placeholder
                        values.push(this._getMemValue(regDataStart + i));
                    }
                    rowid = null; // No existing rowid for INSERT
                } else if (p1 === 1) { // Usually DELETE: R[P2]=Rowid
                    opType = 'DELETE';
                    if (typeof firstVal !== 'bigint') throw new SqliteError("Invalid rowid type for DELETE", StatusCode.INTERNAL);
                    rowid = firstVal;
                    // No 'values' needed for DELETE in our simplified xUpdate signature
                } else if (p1 > 1 && typeof firstVal === 'bigint') { // Usually UPDATE: R[P2]=Rowid, R[P2+1..]=New Values
                    opType = 'UPDATE';
                    rowid = firstVal;
                    for (let i = 1; i < nData; i++) { // Collect new values
                        values.push(this._getMemValue(regDataStart + i));
                    }
                } else {
                    throw new SqliteError(`Cannot determine VUpdate operation type (nData=${nData}, firstValType=${typeof firstVal})`, StatusCode.INTERNAL);
                }


                 try {
                     console.debug(`VUpdate: Op=${opType}, Rowid=${rowid}, Values=`, values);
                     const result = await vtab.module.xUpdate(vtab, values, rowid); // Pass determined rowid

                     // Store returned rowid for INSERT if applicable and needed
                     if (opType === 'INSERT' && regNewRowidDest > 0 && result.rowid !== undefined) {
                         this._setMem(regNewRowidDest, result.rowid);
                     }
                 } catch (e) {
                     if (e instanceof ConstraintError) {
                         // TODO: Implement ON CONFLICT handling - requires jump targets etc.
                         console.warn(`VUpdate constraint violation (onConflict=${ConflictResolution[updateInfo.onConflict]}):`, e.message);
                         // For now, translate to CONSTRAINT error code and let VDBE halt
                         throw new SqliteError(e.message, StatusCode.CONSTRAINT);
                     }
                     throw e; // Re-throw other errors
                 }
                 break;
             }

             case Opcode.VRowid: { // P1=cursorIdx, P2=destReg
                 const cursorIdx = p1;
                 const vdbeCursor = this.cursors[cursorIdx];
                 if (!vdbeCursor?.instance || !vdbeCursor.vtab) {
                     throw new SqliteError(`Invalid cursor ${cursorIdx} for VRowid`, StatusCode.INTERNAL);
                 }
                 if (!vdbeCursor.isValid) {
                     throw new SqliteError(`VRowid called on invalid cursor ${cursorIdx}`, StatusCode.MISUSE);
                 }
                 const rowid = await vdbeCursor.vtab.module.xRowid(vdbeCursor.instance);
                 this._setMem(p2, rowid);
                 break;
             }

             case Opcode.VBegin: // P1=0 (All vtabs) or Cursor Index? Assume 0 for now.
                 for(const vdbeCursor of this.cursors) {
                     if (vdbeCursor.vtab?.module.xBegin) {
                          await vdbeCursor.vtab.module.xBegin(vdbeCursor.vtab);
                     }
                 }
                 break;
            case Opcode.VCommit:
                 for(const vdbeCursor of this.cursors) {
                     if (vdbeCursor.vtab?.module.xCommit) {
                          await vdbeCursor.vtab.module.xCommit(vdbeCursor.vtab);
                     }
                 }
                 break;
            case Opcode.VRollback:
                 for(const vdbeCursor of this.cursors) {
                     if (vdbeCursor.vtab?.module.xRollback) {
                          await vdbeCursor.vtab.module.xRollback(vdbeCursor.vtab);
                     }
                 }
                 break;
            case Opcode.VSync: // Often a no-op for in-memory vtabs, but call if exists
                 for(const vdbeCursor of this.cursors) {
                     if (vdbeCursor.vtab?.module.xSync) {
                          await vdbeCursor.vtab.module.xSync(vdbeCursor.vtab);
                     }
                 }
                 break;

            default:
                throw new SqliteError(`Unimplemented opcode: ${Opcode[inst.opcode]} (${inst.opcode})`, StatusCode.INTERNAL);
        }

        // Default PC increment if instruction didn't handle it
        if (this.programCounter < this.program.instructions.length && this.program.instructions[this.programCounter] === inst) {
             this.programCounter++;
        }
    }

     /** @internal Helper for binary arithmetic ops */
     private _binaryArithOp(r1Idx: number, r2Idx: number, destIdx: number, op: (a: any, b: any) => any): void {
         const v1 = this._getMemValue(r1Idx);
         const v2 = this._getMemValue(r2Idx);
         // Basic numeric coercion (can be refined based on affinity/types)
         const n1 = Number(v1);
         const n2 = Number(v2);
         // TODO: Handle BigInt arithmetic if inputs are bigint
         // TODO: Handle potential NaN results
         if (isNaN(n1) || isNaN(n2)) {
             this._setMem(destIdx, null); // SQLite often results in NULL for NaN inputs
         } else {
             this._setMem(destIdx, op(n1, n2));
         }
     }


    /** @internal Get value, checking bounds */
    _getMemValue(index: number): SqlValue {
        if (index < 0 || index >= this.memoryCells.length) {
             throw new SqliteError(`Invalid memory cell read index ${index}`, StatusCode.INTERNAL);
        }
        return this.memoryCells[index].value;
    }

     /** @internal Set value, checking bounds */
    _setMem(index: number, value: SqlValue): void {
        if (index >= 0 && index < this.memoryCells.length) {
             const finalValue = (value instanceof Uint8Array) ? value.slice() : value;
             this.memoryCells[index] = { value: finalValue };
        } else {
             throw new SqliteError(`Invalid memory cell write index ${index}`, StatusCode.INTERNAL);
        }
    }
}
