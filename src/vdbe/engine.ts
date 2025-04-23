import { StatusCode, type SqlValue, SqlDataType } from '../common/types';
import { SqliteError } from '../common/errors';
import type { Database } from '../core/database';
import type { Statement } from '../core/statement';
import type { VdbeProgram } from './program';
import type { VdbeInstruction, P4Vtab, P4FuncDef, P4SortKey } from './instruction';
import { Opcode, ConflictResolution } from '../common/constants';
import { evaluateIsTrue, compareSqlValues } from '../util/comparison';
import { applyNumericAffinity, applyTextAffinity, applyIntegerAffinity, applyRealAffinity, applyBlobAffinity } from '../util/affinity';
import type { VirtualTableCursor } from '../vtab/cursor';
import type { VirtualTable } from '../vtab/table';
import { FunctionContext } from '../func/context';
import type { TableSchema } from '../schema/table';
import { MemoryTable, MemoryTableModule } from '../vtab/memory-table';

/** Represents a single VDBE memory cell (register) */
export interface MemoryCell {
	value: SqlValue;
}

/** Internal state for stack frame control info */
// interface FrameControlInfo { // Not needed as separate type
// 	returnAddress: number;
// 	oldFramePointer: number;
// }

/** Internal state for a VDBE cursor */
interface VdbeCursor {
	instance: VirtualTableCursor<any> | null;
	vtab: VirtualTable | null;
	isValid: boolean;
	isEof: boolean;
	isEphemeral?: boolean;
	sortedResults?: { rows: MemoryCell[][], index: number } | null;
}

/**
 * Represents an execution instance of a VDBE program.
 * Uses a stack-based memory model with activation frames.
 */
export class Vdbe {
	private readonly db: Database;
	private readonly program: VdbeProgram;
	private readonly stmt: Statement;

	private programCounter: number = 0;
	// --- Stack-based Memory ---
	private stack: MemoryCell[] = []; // Main execution stack
	private framePointer: number = 0; // Points to base of current frame on the stack
	private stackPointer: number = 0; // Points to top of stack (next free slot)
	// --- Updated Frame Layout ---
	// FP+0: Return Address (set by Subroutine)
	// FP+1: Old Frame Pointer (set by FrameEnter)
	// FP+2..N: Locals (set by compiler, init by FrameEnter)
	// FP-1, FP-2,... : Arguments pushed by caller (accessed via negative offset)
	private readonly localsStartOffset = 2; // Locals start after control info
	// --------------------------
	private vdbeCursors: VdbeCursor[]; // Renamed from cursors
	private hasYielded = false;
	private done = false;
	private error: SqliteError | null = null;
	private appliedBindings: boolean = false;
	private vtabContext: FunctionContext;
	private udfContext: FunctionContext;
	private ephemeralTables: Map<number, { table: MemoryTable, module: MemoryTableModule }> = new Map();
	private static ephemeralModule = new MemoryTableModule();
	private aggregateContexts: Map<string | number, any> = new Map();
	private aggregateIterator: Iterator<[string | number, any]> | null = null;
	private currentAggregateEntry: [string | number, any] | null = null;
	private savepoints: string[] = [];

	constructor(stmt: Statement, program: VdbeProgram) {
		this.stmt = stmt;
		this.db = stmt.db;
		this.program = program;
		// --- Initialize Stack ---
		const initialStackSize = Math.max(program.numMemCells + 100, 1000);
		this.stack = new Array(initialStackSize).fill(null).map(() => ({ value: null }));
		this.stackPointer = 0;
		this.framePointer = 0; // Main frame starts at 0
		// -----------------------
		this.vdbeCursors = new Array(program.numCursors).fill(null).map(() => ({
			instance: null,
			vtab: null,
			isValid: false,
			isEof: false,
			sortedResults: null
		}));
		this.vtabContext = new FunctionContext(this.db);
		this.udfContext = new FunctionContext(this.db);
	}

	/** Apply bound parameters. Parameters are placed at absolute stack indices. */
	applyBindings(bindings: Map<number | string, SqlValue>): void {
		if (this.appliedBindings) return;
		console.log("VDBE applying bindings to stack...");
		bindings.forEach((value, key) => {
			const paramInfo = this.program.parameters.get(key);
			const stackIndex = paramInfo?.memIdx; // Absolute index from compiler
			if (stackIndex !== undefined && stackIndex >= 0) {
				// Parameters are generally for the main frame, access directly.
				this._setStackValue(stackIndex, value);
			} else {
				console.warn(`Could not map parameter ${key} to stack cell`);
			}
		});
		this.appliedBindings = true;
	}

	clearAppliedBindings(): void {
		this.appliedBindings = false;
	}

	/** Resets the VDBE to its initial state */
	async reset(): Promise<void> {
		this.programCounter = 0;
		this.stackPointer = 0;
		this.framePointer = 0;
		this.appliedBindings = false;
		this.hasYielded = false;
		this.done = false;
		this.error = null;
		this.udfContext._clear();
		this.udfContext._cleanupAuxData();
		this.aggregateContexts.clear();
		this.aggregateIterator = null;
		this.currentAggregateEntry = null;
		this.savepoints = [];

		const closePromises: Promise<void>[] = [];
		for (let i = 0; i < this.vdbeCursors.length; i++) {
			const cursor = this.vdbeCursors[i];
			if (cursor.sortedResults) cursor.sortedResults = null;
			if (cursor.instance) closePromises.push(cursor.vtab!.module.xClose(cursor.instance));
			if (cursor.isEphemeral) this.ephemeralTables.delete(i);
			this.vdbeCursors[i] = { instance: null, vtab: null, isValid: false, isEof: false, sortedResults: null };
		}
		this.ephemeralTables.clear();
		await Promise.allSettled(closePromises);
	}

	/** Executes the VDBE program */
	async run(): Promise<StatusCode> {
		if (this.done || this.error) {
			return this.error ? this.error.code : StatusCode.MISUSE;
		}
		this.hasYielded = false;

		try {
			if (!this.appliedBindings) {
				// Apply empty bindings if none were provided, to ensure parameter slots are initialized (likely to null)
				this.applyBindings(new Map());
			}
			while (!this.done && !this.hasYielded && !this.error) {
				const instruction = this.program.instructions[this.programCounter];
				if (!instruction) {
					this.error = new SqliteError(`Invalid program counter: ${this.programCounter}`, StatusCode.INTERNAL);
					break;
				}

				console.debug(`VDBE Exec: [${this.programCounter}] FP=${this.framePointer} SP=${this.stackPointer} ${Opcode[instruction.opcode]} ${instruction.p1} ${instruction.p2} ${instruction.p3} ${instruction.p4 !== null ? `P4:${String(instruction.p4)}` : ''} ${instruction.comment ? `-- ${instruction.comment}` : ''}`);

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

	// --- Stack Access Helpers ---
	/** Sets an absolute stack index */
	private _setStackValue(index: number, value: SqlValue): void {
		if (index < 0) throw new SqliteError(`Invalid stack write index ${index}`, StatusCode.INTERNAL);
		// Ensure stack capacity
		while (index >= this.stack.length) this.stack.push({ value: null });
		// Update stack pointer if writing beyond current top
		if (index >= this.stackPointer) this.stackPointer = index + 1;
		// Ensure cell exists (though while loop should handle it)
		if (!this.stack[index]) this.stack[index] = { value: null };
		// Deep copy blobs, other values are immutable or primitives
		this.stack[index].value = (value instanceof Uint8Array) ? value.slice() : value;
	}

	/** Gets an absolute stack index */
	private _getStackValue(index: number): SqlValue {
		if (index < 0 || index >= this.stackPointer) {
			// Accessing uninitialized stack or below stack base - return NULL
			// console.warn(`Read attempt outside stack bounds: Index=${index}, SP=${this.stackPointer}`);
			return null;
		}
		// Cell might not exist if stack shrunk and grew again? Unlikely with current logic.
		return this.stack[index]?.value ?? null;
	}

	/** Gets value relative to Frame Pointer (handles locals, control info, and caller args) */
	private _getMemValue(frameOffset: number): SqlValue {
		const stackIndex = this.framePointer + frameOffset;
		return this._getStackValue(stackIndex);
	}

	/** Sets value relative to Frame Pointer (only for locals >= localsStartOffset) */
	private _setMem(frameOffset: number, value: SqlValue): void {
		// Strict check: Only allow setting locals via _setMem
		if (frameOffset < this.localsStartOffset) {
			throw new SqliteError(`Write attempt to control info/argument area via _setMem: Offset=${frameOffset}`, StatusCode.INTERNAL);
		}
		const stackIndex = this.framePointer + frameOffset;
		// Check if writing within the allocated *current* frame bounds is needed?
		// For now, assume compiler allocated enough stack space via numMemCells.
		// if (stackIndex >= this.stackPointer) { // This check is problematic if stack grows dynamically
		// 	throw new SqliteError(`Write stack access potentially out of frame bounds: FP=${this.framePointer}, Offset=${frameOffset}, SP=${this.stackPointer}`, StatusCode.INTERNAL);
		// }
		this._setStackValue(stackIndex, value);
	}
	// -------------------------

	/** Executes a single VDBE instruction */
	private async executeInstruction(inst: VdbeInstruction): Promise<void> {
		const p1 = inst.p1;
		const p2 = inst.p2;
		const p3 = inst.p3;
		const p4 = inst.p4;
		const p5 = inst.p5;

		const conditionalJump = (result: boolean) => {
			if (result) this.programCounter = p2;
			else this.programCounter++;
		};

		switch (inst.opcode) {
			case Opcode.Init: this.programCounter = p2; return;
			case Opcode.Goto: this.programCounter = p2; return;

			// --- Frame Management ---
			case Opcode.FrameEnter: { // P1=FrameSize (num locals + control info)
				const frameSize = p1; // Includes control info + locals
				// Calculate new FP. Return Address should already be at SP by Subroutine call.
				const newFP = this.stackPointer - 1; // FP points to Return Addr slot
				// Ensure stack capacity (including locals)
				const requiredStackTop = newFP + frameSize;
				while (requiredStackTop > this.stack.length) this.stack.push({ value: null });

				// Save Control Info: Old FP
				this._setStackValue(newFP + 1, this.framePointer); // Save Old FP at FP+1

				// Initialize locals to NULL (FP+localsStartOffset to FP+frameSize-1)
				for (let i = this.localsStartOffset; i < frameSize; i++) {
					this._setStackValue(newFP + i, null);
				}

				this.framePointer = newFP; // Update FP to new frame base
				this.stackPointer = requiredStackTop; // Update SP to top of allocated frame
				break; // PC increments normally
			}
			case Opcode.FrameLeave: { // P1= Unused (Return handles jump)
				if (this.framePointer === 0 && this._getStackValue(1) === null) { // Check if we are in the initial frame
					console.warn("FrameLeave called on base frame? Potentially harmless if program ends.");
					// Don't change FP or SP if it's the base frame.
				} else {
					// Get Old FP from current frame's control info
					const oldFPVal = this._getStackValue(this.framePointer + 1); // Old FP is at FP+1
					const oldFP = typeof oldFPVal === 'number' ? oldFPVal : -1;
					if (isNaN(oldFP) || oldFP < 0) throw new SqliteError(`Invalid old frame pointer ${oldFPVal} at FP ${this.framePointer + 1}`, StatusCode.INTERNAL);

					this.stackPointer = this.framePointer; // Pop frame by resetting SP to frame base (where RetAddr was)
					this.framePointer = oldFP; // Restore caller's FP
				}
				break; // PC increments normally (Return opcode handles the jump)
			}
			// -------------------------

			// --- New Opcode.Push ---
			case Opcode.Push: { // P1=SrcRegOffset (relative to current FP)
				const valueToPush = this._getMemValue(p1);
				// Push onto the absolute top of the stack
				this._setStackValue(this.stackPointer, valueToPush); // SP automatically increments
				break;
			}
			// -----------------------

			// --- Subroutine/Return (Stack Frame Aware) ---
			case Opcode.Subroutine: { // P1=NumArgsPushed, P2=addr_Target
				const numArgs = p1; // May not be strictly needed if using negative offsets
				const targetAddr = p2;
				const returnAddr = this.programCounter + 1;

				// Save return address at the current stack top (this becomes FP+0 of new frame)
				this._setStackValue(this.stackPointer, returnAddr); // SP increments

				this.programCounter = targetAddr; // Jump to subroutine
				return; // PC handled
			}
			case Opcode.Return: { // P1=unused
				// Assumes FrameLeave was called just before this.
				// Get Return Addr from the base of the frame we just popped,
				// which is where SP is currently pointing after FrameLeave.
				const jumpTargetVal = this._getStackValue(this.stackPointer); // Read RetAddr saved by Subroutine (now at SP)
				const jumpTarget = typeof jumpTargetVal === 'number' ? jumpTargetVal : -1;
				if (!Number.isInteger(jumpTarget) || jumpTarget < 0) throw new SqliteError(`Invalid return address ${jumpTargetVal} at SP ${this.stackPointer} (expected after FrameLeave)`, StatusCode.INTERNAL);

				// Pop the return address itself
				this.stackPointer++; // Increment SP *after* reading the value at the old SP

				this.programCounter = jumpTarget;
				return; // PC handled
			}
			// -------------------------------------------

			// --- Standard Register Ops (Use _setMem/_getMem for frame-relative access) ---
			case Opcode.Integer: this._setMem(p2, p1); break;
			case Opcode.Int64: this._setMem(p2, this.program.constants[p4 as number]); break;
			case Opcode.String8: this._setMem(p2, this.program.constants[p4 as number]); break;
			case Opcode.Null: this._setMem(p2, null); break;
			case Opcode.Real: this._setMem(p2, this.program.constants[p4 as number]); break;
			case Opcode.Blob: this._setMem(p2, this.program.constants[p4 as number]); break;
			case Opcode.ZeroBlob: { const s=Number(this._getMemValue(p1)); this._setMem(p2, new Uint8Array(s>=0?Math.trunc(s):0)); break; }
			case Opcode.SCopy: this._setMem(p2, this._getMemValue(p1)); break;
			case Opcode.Clear: {
				const startOffset = p1;
				const count = p2;
				// Ensure clearing starts within the local variable area
				if (startOffset < this.localsStartOffset) {
					throw new SqliteError(`Clear opcode attempt to clear control/arg area: Offset=${startOffset}`, StatusCode.INTERNAL);
				}
				const clearStartIdx = this.framePointer + startOffset;
				const clearEndIdx = clearStartIdx + count;
				// Bounds check against SP
				if (clearStartIdx < 0 || clearEndIdx > this.stackPointer) {
					throw new SqliteError(`Clear opcode stack access out of bounds: FP=${this.framePointer} Offset=${startOffset} Count=${count} SP=${this.stackPointer}`, StatusCode.INTERNAL);
				}
				for (let i = clearStartIdx; i < clearEndIdx; i++) {
					this._setStackValue(i, null);
				}
				break;
			}
			case Opcode.IfTrue: conditionalJump(evaluateIsTrue(this._getMemValue(p1))); return;
			case Opcode.IfFalse: conditionalJump(!evaluateIsTrue(this._getMemValue(p1))); return;
			case Opcode.IfZero: { const v = this._getMemValue(p1); conditionalJump(v === 0 || v === 0n || v === null); return; }
			case Opcode.IfNull: conditionalJump(this._getMemValue(p1) === null); return;
			case Opcode.IfNotNull: conditionalJump(this._getMemValue(p1) !== null); return;
			case Opcode.IsNull: this._setMem(p2, this._getMemValue(p1) === null); break;
			case Opcode.NotNull: this._setMem(p2, this._getMemValue(p1) !== null); break;
			// Comparisons use frame-relative _getMemValue implicitly
			case Opcode.Eq: conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) === 0); return;
			case Opcode.Ne: conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) !== 0); return;
			case Opcode.Lt: conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) < 0); return;
			case Opcode.Le: conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) <= 0); return;
			case Opcode.Gt: conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) > 0); return;
			case Opcode.Ge: conditionalJump(compareSqlValues(this._getMemValue(p3), this._getMemValue(p1)) >= 0); return;
			// Arithmetic/String ops use frame-relative _getMemValue/_setMem implicitly
			case Opcode.Add: this._binaryArithOp(p1, p2, p3, (a, b) => Number(a) + Number(b)); break; // Needs BigInt check
			case Opcode.Subtract: this._binaryArithOp(p1, p2, p3, (a, b) => Number(b) - Number(a)); break; // Needs BigInt check
			case Opcode.Multiply: this._binaryArithOp(p1, p2, p3, (a, b) => Number(a) * Number(b)); break; // Needs BigInt check
			case Opcode.Divide: { const d = this._getMemValue(p1); const n = this._getMemValue(p2); this._setMem(p3, (d === 0 || d === 0n || d === null || n === null || Number(d) === 0) ? null : Number(n) / Number(d)); } break;
			case Opcode.Remainder: { const d = this._getMemValue(p1); const n = this._getMemValue(p2); let res: SqlValue = null; try { if(d!==null && n!==null) { if(typeof d==='bigint' || typeof n==='bigint'){const b1=BigInt(d as any);const b2=BigInt(n as any);if(b1!==0n)res=b2%b1;}else{const n1=Number(d);const n2=Number(n);if(n1!==0&&!isNaN(n1)&&!isNaN(n2))res=n2%n1;}}}catch{} this._setMem(p3, res); } break;
			case Opcode.Concat: { let r = ''; for (let i = p1; i <= p2; i++) { const v = this._getMemValue(i); if(v!==null && !(v instanceof Uint8Array)) r += String(v); } this._setMem(p3, r); break; }
			case Opcode.Negative: { const v = this._getMemValue(p1); let res: SqlValue = null; try { if(v!==null) res = typeof v === 'bigint' ? -v : -Number(v); if(typeof res === 'number' && isNaN(res)) res = null; } catch { res = null; } this._setMem(p2, res); } break;
			case Opcode.BitAnd: case Opcode.BitOr: { const v1=this._getMemValue(p1); const v2=this._getMemValue(p2); let res: SqlValue = null; try { if(v1!==null&&v2!==null){ const i1=BigInt(v1 as any); const i2=BigInt(v2 as any); res = inst.opcode===Opcode.BitAnd ? (i1&i2) : (i1|i2); } } catch { res = 0n; } this._setMem(p3, res); break; }
			case Opcode.ShiftLeft: case Opcode.ShiftRight: { const amt=this._getMemValue(p1); const val=this._getMemValue(p2); let res: SqlValue = null; try { if(amt!==null&&val!==null){ const iAmt=BigInt(amt as any); const iVal=BigInt(val as any); res = inst.opcode===Opcode.ShiftLeft ? (iVal<<iAmt) : (iVal>>iAmt); } } catch { res = 0n; } this._setMem(p3, res); break; }
			case Opcode.BitNot: { const v=this._getMemValue(p1); let res: SqlValue = null; try { if(v!==null) res = ~BigInt(v as any); } catch { res = -1n; } this._setMem(p2, res); break; }
			// --- Function calls use frame-relative args ---
			case Opcode.Function: {
				const p4Func = p4 as P4FuncDef; if(!p4Func || p4Func.type !== 'funcdef') throw new SqliteError("Invalid P4 for Function", StatusCode.INTERNAL);
				// Args start at frame offset p2
				const args: SqlValue[] = []; for(let i=0; i<p4Func.nArgs; i++) args.push(this._getMemValue(p2 + i));
				this.udfContext = new FunctionContext(this.db, p4Func.funcDef.userData); this.udfContext._clear();
				try { p4Func.funcDef.xFunc!(this.udfContext, Object.freeze(args)); const err = this.udfContext._getError(); if(err) throw err; this._setMem(p3, this.udfContext._getResult()); } catch(e) { if(e instanceof Error) throw new SqliteError(`Func ${p4Func.funcDef.name}: ${e.message}`, StatusCode.ERROR); throw e; }
				break;
			}
			// --- Aggregation Ops use frame-relative args/keys ---
			case Opcode.MakeRecord: { const v:SqlValue[]=[]; for(let i=0; i<p2; i++) v.push(this._getMemValue(p1+i)); const serKey = JSON.stringify(v, (_,val)=>typeof val==='bigint'?val.toString()+'n':val instanceof Uint8Array?`blob:${Buffer.from(val).toString('hex')}`:val); this._setMem(p3, serKey); break; }
			case Opcode.AggStep: {
				const p4Func = p4 as P4FuncDef; if(!p4Func || p4Func.type !== 'funcdef') throw new SqliteError("Invalid P4 for AggStep", StatusCode.INTERNAL);
				const serializedKey = this._getMemValue(p3) as string;
				let mapKey:string|number = serializedKey; // TODO: Key deserialization if needed
				const args: SqlValue[] = []; for(let i=0; i<p4Func.nArgs; i++) args.push(this._getMemValue(p2+i));
				let entry = this.aggregateContexts.get(mapKey);

				// Reuse UDF context, ensure it's clean before xStep
				this.udfContext._clear();
				this.udfContext._setAggregateContextRef(entry?.accumulator);

				try {
					// Call xStep
					p4Func.funcDef.xStep!(this.udfContext, Object.freeze(args));

					// Check if xStep set an error via context.resultError()
					const stepError = this.udfContext._getError();
					if (stepError) {
						throw stepError; // Throw to be caught below
					}

					// Update accumulator if necessary
					const newAcc = this.udfContext._getAggregateContextRef();
					if(entry === undefined && newAcc !== undefined){
						const keys=[]; for(let i=0; i<p5; i++) keys.push(this._getMemValue(p1+i));
						this.aggregateContexts.set(mapKey, {accumulator:newAcc, keyValues:Object.freeze(keys)});
					} else if(entry !== undefined && newAcc !== undefined && newAcc !== entry.accumulator) {
						entry.accumulator = newAcc;
					}
				} catch(e) {
					// Halt VDBE execution on error from xStep
					console.error(`VDBE AggStep Error in function ${p4Func.funcDef.name}:`, e);
					if (e instanceof SqliteError) {
						this.error = e;
					} else if (e instanceof Error) {
						this.error = new SqliteError(`Runtime error in aggregate ${p4Func.funcDef.name} xStep: ${e.message}`, StatusCode.ERROR);
					} else {
						this.error = new SqliteError(`Unknown runtime error in aggregate ${p4Func.funcDef.name} xStep`, StatusCode.INTERNAL);
					}
					this.done = true; // Halt execution
					return; // Don't increment PC
				}
				break;
			}
			case Opcode.AggFinal: {
				const p4Func = p4 as P4FuncDef; if(!p4Func || p4Func.type !== 'funcdef') throw new SqliteError("Invalid P4 for AggFinal", StatusCode.INTERNAL);
				const serializedKey = this._getMemValue(p1) as string; let mapKey:string|number = serializedKey; /* ... */
				const entry = this.aggregateContexts.get(mapKey);
				this.udfContext = new FunctionContext(this.db, p4Func.funcDef.userData); this.udfContext._clear(); this.udfContext._setAggregateContextRef(entry?.accumulator);
				try { p4Func.funcDef.xFinal!(this.udfContext); const err = this.udfContext._getError(); if(err) throw err; this._setMem(p3, this.udfContext._getResult()); } catch(e) { /*...*/ }
				break;
			}
			// Aggregation iteration uses frame-relative destinations
			case Opcode.AggIterate: this.aggregateIterator = this.aggregateContexts.entries(); this.currentAggregateEntry = null; break;
			case Opcode.AggNext: if(!this.aggregateIterator)throw new Error();const n=this.aggregateIterator.next();if(n.done){this.currentAggregateEntry=null;this.programCounter=p2;}else{this.currentAggregateEntry=n.value;this.programCounter++;} return;
			case Opcode.AggKey: if(!this.currentAggregateEntry)throw new Error(); let storeKey:SqlValue=this.currentAggregateEntry[0]; /* ... deserialize key ... */ this._setMem(p2, storeKey); break;
			case Opcode.AggContext: if(!this.currentAggregateEntry)throw new Error(); this._setMem(p2, this.currentAggregateEntry[1]?.accumulator); break;
			case Opcode.AggGroupValue: if(!this.currentAggregateEntry)throw new Error(); this._setMem(p3, this.currentAggregateEntry[1]?.keyValues[p2]??null); break;
			// Affinity uses frame-relative registers
			case Opcode.Affinity: {
				const startOffset = p1;
				const count = p2;
				const affinityStr = (p4 as string).toUpperCase(); // Ensure case-insensitivity

				// Ensure range is valid relative to current frame and stack
				const startIdx = this.framePointer + startOffset;
				const endIdx = startIdx + count;
				if (startOffset < this.localsStartOffset) {
					throw new SqliteError(`Affinity opcode attempt on control/arg area: Offset=${startOffset}`, StatusCode.INTERNAL);
				}
				if (startIdx < 0 || endIdx > this.stackPointer) {
					throw new SqliteError(`Affinity opcode stack access out of bounds: FP=${this.framePointer} Offset=${startOffset} Count=${count} SP=${this.stackPointer}`, StatusCode.INTERNAL);
				}

				// Determine the affinity function based on p4 string
				let applyAffinityFn: (v: SqlValue) => SqlValue;
				switch (affinityStr) {
					case 'NUMERIC': applyAffinityFn = applyNumericAffinity; break;
					case 'INTEGER': applyAffinityFn = applyIntegerAffinity; break;
					case 'REAL': applyAffinityFn = applyRealAffinity; break;
					case 'TEXT': applyAffinityFn = applyTextAffinity; break;
					case 'BLOB': applyAffinityFn = applyBlobAffinity; break;
					default:
						// NONE affinity or unknown: no-op
						applyAffinityFn = (v) => v;
				}

				// Apply affinity to the specified range of registers
				for (let i = 0; i < count; i++) {
					const offset = startOffset + i;
					const currentValue = this._getMemValue(offset);
					const newValue = applyAffinityFn(currentValue);
					// Only update if the value actually changed
					if (newValue !== currentValue) {
						this._setMem(offset, newValue);
					}
				}
				break;
			}
			// --------------------------------------------------

			// --- Opcodes needing careful Stack Pointer/Frame Pointer awareness ---
			case Opcode.Move: {
				const srcOffset = p1; const destOffset = p2; const count = p3;
				const srcBaseIdx = this.framePointer + srcOffset;
				const destBaseIdx = this.framePointer + destOffset;
				// Bounds check required against actual allocated stack (SP)
				if (srcBaseIdx < 0 || destBaseIdx < 0 || srcBaseIdx + count > this.stackPointer || destBaseIdx + count > this.stackPointer) {
					 throw new SqliteError(`Move opcode stack access out of bounds: FP=${this.framePointer} SrcOff=${srcOffset} DestOff=${destOffset} Count=${count} SP=${this.stackPointer}`, StatusCode.INTERNAL);
				}
				// Use absolute indices for copy logic
				if (srcBaseIdx === destBaseIdx) break;
				// Overlap check (copy backwards if dest overlaps and is higher)
				if (destBaseIdx > srcBaseIdx && destBaseIdx < srcBaseIdx + count) {
					for (let i = count - 1; i >= 0; i--) this._setStackValue(destBaseIdx + i, this._getStackValue(srcBaseIdx + i));
				} else { // Copy forwards
					for (let i = 0; i < count; i++) this._setStackValue(destBaseIdx + i, this._getStackValue(srcBaseIdx + i));
				}
				break;
			}
			// --------------------------------------------------------------------

			// --- Cursor Ops (vdbeCursors is global, use _setMem/_getMem for registers) ---
			case Opcode.OpenRead: { const cIdx = p1; const schema = p4 as TableSchema; if(!schema?.vtabInstance) throw new Error("Missing vtab instance"); const v = schema.vtabInstance!; const ci = await v.module.xOpen(v); this.vdbeCursors[cIdx] = {instance:ci, vtab:v, isValid:false, isEof:false, sortedResults:null}; break; }
			case Opcode.OpenWrite: { const cIdx = p1; const schema = p4 as TableSchema; if(!schema?.vtabInstance) throw new Error("Missing vtab instance"); const v = schema.vtabInstance!; const ci = await v.module.xOpen(v); this.vdbeCursors[cIdx] = {instance:ci, vtab:v, isValid:false, isEof:false, sortedResults:null}; break; }
			case Opcode.Close: { const cIdx = p1; const c = this.vdbeCursors[cIdx]; if(c){ if(c.sortedResults)c.sortedResults=null; if(c.instance)await c.vtab!.module.xClose(c.instance); if(c.isEphemeral)this.ephemeralTables.delete(cIdx); this.vdbeCursors[cIdx]={instance:null,vtab:null,isValid:false,isEof:false,sortedResults:null};} break; }
			case Opcode.VFilter: { const cIdx=p1, addr=p2, argsReg=p3, info=p4 as any; const c=this.vdbeCursors[cIdx]; if(!c?.vtab || !c.instance) throw new Error("VFilter on unopened cursor"); const args=[]; for(let i=0;i<info.nArgs;i++)args.push(this._getMemValue(argsReg+i)); await c.vtab!.module.xFilter(c.instance!,info.idxNum,info.idxStr,args); const eof=await c.vtab!.module.xEof(c.instance!); c.isEof=eof; c.isValid=!eof; if(eof)this.programCounter=addr; else this.programCounter++; return; }
			case Opcode.VNext: { const cIdx=p1, addr=p2; const c=this.vdbeCursors[cIdx]; if(c?.sortedResults){ /*...*/ return; } if(!c?.instance)throw new Error("VNext on unopened cursor"); await c.vtab!.module.xNext(c.instance); const eof=await c.vtab!.module.xEof(c.instance); c.isEof=eof; c.isValid=!eof; if(eof)this.programCounter=addr; else this.programCounter++; return; }
			case Opcode.Rewind: { const cIdx=p1, addr=p2; const c=this.vdbeCursors[cIdx]; if(c?.sortedResults){ /*...*/ return; } if(!c?.instance)throw new Error("Rewind on unopened cursor"); await c.vtab!.module.xFilter(c.instance,0,null,[]); const eof=await c.vtab!.module.xEof(c.instance); c.isEof=eof; c.isValid=!eof; if(eof)this.programCounter=addr; else this.programCounter++; return; }
			// VColumn/VRowid/VUpdate use frame-relative destinations (_setMem)
			case Opcode.VColumn: { const cIdx=p1, col=p2, destOff=p3; const c=this.vdbeCursors[cIdx]; if(c?.sortedResults){ const s=c.sortedResults; if(s.index<0||s.index>=s.rows.length)throw new Error(); const r=s.rows[s.index]; if(col<0||col>=r.length)throw new Error(); this._setMem(destOff,r[col].value); break; } if(!c?.instance||!c.isValid)throw new Error("VColumn on invalid cursor"); this.vtabContext._clear(); const st=c.vtab!.module.xColumn(c.instance,this.vtabContext,col); if(st!==StatusCode.OK)throw new SqliteError(`xColumn failed (col ${col}, cursor ${cIdx})`, st); this._setMem(destOff, this.vtabContext._getResult()); break; }
			case Opcode.VRowid: { const cIdx=p1, destOff=p2; const c=this.vdbeCursors[cIdx]; if(!c?.instance||!c.isValid)throw new Error("VRowid on invalid cursor"); const rid=await c.vtab!.module.xRowid(c.instance); this._setMem(destOff, rid); break; }
			case Opcode.VUpdate:				 // regno p1 p2 p3 p4 p5
				{
					const regDataStart = p2; // Start register of data (rowid, col0, col1...)
					const regOut = p3;	 	 // Register to store result (e.g., new rowid for INSERT)
					const nData = p1; // Number of data elements (including rowid)
					// Correctly get p4 info from the instruction
					const p4Info = p4 as { table: TableSchema, onConflict?: ConflictResolution };
					if (!p4Info?.table?.vtabInstance?.module?.xUpdate) {
						throw new Error("VUpdate called on non-virtual table or module lacks xUpdate");
					}

					const values: SqlValue[] = [];
					for (let i = 0; i < nData; i++) {
						// Use _getMemValue which handles initialization
						values.push(this._getMemValue(regDataStart + i) ?? null);
					}
					// Pass conflict policy via a non-standard property
					(values as any)._onConflict = p4Info.onConflict || ConflictResolution.ABORT;

					const rowidFromData = values[0]; // First value is rowid (or null for insert)

					try {
						// Call xUpdate asynchronously
						const result = await p4Info.table.vtabInstance.module.xUpdate(p4Info.table.vtabInstance, values, rowidFromData as bigint | null);

						// Handle result based on operation and conflict policy
						if (regOut > 0) {
							if (values[0] === null) { // INSERT operation
								if (result && result.rowid !== undefined) {
									// Successful INSERT, store new rowid
									this._setMem(regOut, result.rowid);
								} else {
									// INSERT failed or was ignored (due to IGNORE conflict policy)
									// For CTE UNION DISTINCT, we need NULL in regOut if insert was ignored.
									this._setMem(regOut, null);
								}
							} else {
								// UPDATE/DELETE operation, typically don't write to regOut
								this._setMem(regOut, null); // Set to NULL for consistency
							}
						}
					} catch (e) {
						// If xUpdate throws, halt the VDBE
						if (e instanceof SqliteError) {
							this.error = e;
						} else if (e instanceof Error) {
							this.error = new SqliteError(`Runtime error during VUpdate: ${e.message}`, StatusCode.ERROR);
						} else {
							this.error = new SqliteError("Unknown error during VUpdate execution", StatusCode.ERROR);
						}
						this.done = true; // Halt execution on error
						return; // Exit step function
					}
				}
				break;
			// VTab transaction ops are okay
			case Opcode.VBegin: case Opcode.VCommit: case Opcode.VRollback: case Opcode.VSync:
			case Opcode.VSavepoint: case Opcode.VRelease: case Opcode.VRollbackTo:
				// These ops iterate through cursors and call vtab methods
				// They don't directly interact with VDBE stack memory in complex ways
				// Placeholder for actual implementation:
				console.warn(`VTab transaction Opcode ${Opcode[inst.opcode]} not fully implemented`);
				break;
			// -----------------------------------------

			// --- ResultRow ---
			case Opcode.ResultRow: // P1=startOffset, P2=count
				const startIdx = this.framePointer + p1;
				if (startIdx < 0 || startIdx + p2 > this.stackPointer) {
					throw new SqliteError(`ResultRow stack access out of bounds: FP=${this.framePointer} Offset=${p1} Count=${p2} SP=${this.stackPointer}`, StatusCode.INTERNAL);
				}
				// Slice the stack directly for the result row
				this.stmt._setCurrentRow(this.stack.slice(startIdx, startIdx + p2));
				this.hasYielded = true;
				this.programCounter++;
				return;
			// -----------------

			case Opcode.Sort: // P1=cursorIdx, P4=SortKeyInfo
				console.warn("Opcode.Sort execution logic needs review for stack frame compatibility.");
				// Needs careful review of how ephemeral tables and sorting interact with frames.
				// Placeholder: Assuming it works for now.
				break;

			case Opcode.Halt:
				this.done = true;
				if (p1 !== StatusCode.OK) {
					this.error = new SqliteError(p4 ?? `Execution halted with code ${p1}`, p1);
				}
				return;

			case Opcode.Noop: break; // Do nothing

			// --- Ephemeral Table Opcodes ---
			case Opcode.OpenEphemeral: { // P1=cursorIdx, P2=numCols, P4=TableSchema?
				const ephCursorIdx = p1;
				const ephNumCols = p2;
				const providedSchema = p4 as TableSchema | null; // Schema might be passed in P4

				// Create the MemoryTable instance first
				const ephTable = new MemoryTable(this.db, Vdbe.ephemeralModule, '_temp_internal', `_eph_${ephCursorIdx}`);
				this.ephemeralTables.set(ephCursorIdx, { table: ephTable, module: Vdbe.ephemeralModule });

				// Initialize columns and B-Tree based on whether a schema was provided
				if (providedSchema && providedSchema.columns && providedSchema.primaryKeyDefinition) {
					// Use the provided schema (likely for a sorter)
					console.log(`VDBE OpenEphemeral: Initializing cursor ${ephCursorIdx} with provided schema (PK def length: ${providedSchema.primaryKeyDefinition.length})`);
					// Map TableSchema columns to the simpler format setColumns expects
					const cols = providedSchema.columns.map(c => ({ name: c.name, type: c.affinity }));
					ephTable.setColumns(cols, providedSchema.primaryKeyDefinition);
				} else {
					// Default initialization (basic columns, rowid key)
					console.log(`VDBE OpenEphemeral: Initializing cursor ${ephCursorIdx} with default schema (${ephNumCols} cols)`);
					const defaultCols = Array.from({ length: ephNumCols }, (_, i) => ({ name: `eph_col${i}`, type: SqlDataType.TEXT }));
					ephTable.setColumns(defaultCols, []); // Empty pkDef means rowid key
				}

				// Now open the cursor on the configured table
				const ephInstance = await Vdbe.ephemeralModule.xOpen(ephTable);
				this.vdbeCursors[ephCursorIdx] = { instance: ephInstance, vtab: ephTable, isValid: false, isEof: false, isEphemeral: true };
				break;
			}

			// --- New Opcode.StackPop ---
			case Opcode.StackPop: { // P1=Count
				const count = p1;
				if (count < 0) throw new SqliteError("StackPop count cannot be negative", StatusCode.INTERNAL);
				if (this.stackPointer < count) {
					throw new SqliteError(`Stack underflow during StackPop: SP=${this.stackPointer}, Count=${count}`, StatusCode.INTERNAL);
				}
				// Simply move the stack pointer down. No need to null out cells (lazy cleanup).
				this.stackPointer -= count;
				break;
			}
			// -------------------------

			default:
				throw new SqliteError(`Unsupported opcode: ${Opcode[inst.opcode]} (${inst.opcode})`, StatusCode.INTERNAL);
		}

		// Default PC increment
		if (this.programCounter < this.program.instructions.length && this.program.instructions[this.programCounter] === inst) {
			this.programCounter++;
		}
	}

	// --- Updated binaryArithOp ---
	private _binaryArithOp(r1Offset: number, r2Offset: number, destOffset: number, op: (a: any, b: any) => any): void {
		const v1 = this._getMemValue(r1Offset);
		const v2 = this._getMemValue(r2Offset);
		let result: SqlValue = null;
		// Basic numeric coercion (can be refined for BigInt)
		if (v1 !== null && v2 !== null) {
			if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
				try { result = op(BigInt(v1 as any), BigInt(v2 as any)); } catch { result = null; }
			} else {
				const n1 = Number(v1);
				const n2 = Number(v2);
				if (!isNaN(n1) && !isNaN(n2)) {
					try { result = op(n1, n2); } catch { result = null; }
				}
			}
		}
		this._setMem(destOffset, result);
	}
}
