import { type SqlValue, StatusCode } from '../common/types';
import { MisuseError, SqliteError, SyntaxError } from '../common/errors';
import type { Database } from './database';
// Placeholder for VDBE execution result
// import { VdbeResult } from '../vdbe/engine';

// --- Add VDBE imports ---
import { type VdbeProgram, VdbeProgramBuilder } from '../vdbe/program';
import { Vdbe, type MemoryCell } from '../vdbe/engine';
import { createInstruction } from '../vdbe/instruction'; // For placeholder compile
import { Opcode, IndexConstraintOp } from '../common/constants'; // For placeholder compile
// ------------------------

import type { SelectAst, SelectColumn, WhereClauseSimple } from '../parser/ast'; // Simulated AST
import type { TableSchema } from '../schema/table';
import type { IndexInfo, IndexConstraint, IndexConstraintUsage } from '../vtab/indexInfo';

// Helper type guard for parameters in AST
function isParameter(value: SqlValue | { type: 'parameter', key: number | string }): value is { type: 'parameter', key: number | string } {
    return typeof value === 'object' && value !== null && value.hasOwnProperty('type') && (value as any).type === 'parameter';
}

/**
 * Represents a prepared SQL statement.
 */
export class Statement {
    public readonly db: Database;
    public readonly sql: string;
    private finalized = false;
    private busy = false; // True if step has been called but not reset/finalized/done
    private boundParameters: Map<number | string, SqlValue> = new Map();
    private columnNames: string[] = []; // Populated after first successful step
    private currentRowInternal: MemoryCell[] | null = null; // Store raw MemoryCells from VDBE

    // --- Add VDBE program and engine references ---
    private vdbeProgram: VdbeProgram | null = null;
    private vdbe: Vdbe | null = null;
    private needsCompile = true;
    // -----------------------------------------------

    /** @internal */
    constructor(db: Database, sql: string) {
        this.db = db;
        this.sql = sql;
        // Defer compilation until first step or explicit compile call
    }

    // --- Simulate Parsing ---
    /** @internal Simulates parsing the SQL into our AST structure. Replace with real parser later. */
    private simulateParse(): SelectAst {
        // VERY basic simulation - assumes SELECT * FROM vtab [WHERE col = ?]
        console.warn("SQL parsing simulation active!");
        const sqlLower = this.sql.toLowerCase().trim();
        let tableName = 'unknown';
        let where: SelectAst['whereClause'] = null;
        let columns: SelectColumn[] = [{ type: 'all' }]; // Default to '*'

        const fromMatch = sqlLower.match(/from\s+([a-z_]\w*)/);
        if (fromMatch) {
            tableName = fromMatch[1];
        } else {
            throw new SyntaxError(`Could not find FROM clause in: ${this.sql}`);
        }

        const selectMatch = sqlLower.match(/select\s+(.*?)\s+from/);
        if (selectMatch && selectMatch[1] !== '*') {
            columns = selectMatch[1].split(',').map(c => ({ type: 'column', name: c.trim() }));
        }


        const whereMatch = this.sql.match(/where\s+([a-z_]\w*)\s*=\s*(\?|\d+|'[^']+'|"[^"]+")/i); // Match ?, number, or quoted string
        if (whereMatch) {
            const colName = whereMatch[1];
            const valStr = whereMatch[2];
            let value: SqlValue | { type: 'parameter', key: number | string };
            if (valStr === '?') {
                // Assuming only one '?' for now, assign index 1
                value = { type: 'parameter', key: 1 };
            } else if (valStr.startsWith("'") || valStr.startsWith('"')) {
                value = valStr.slice(1, -1); // Simple string literal unquoting
            } else {
                value = Number(valStr); // Simple number literal parsing
                if (isNaN(value)) {
                    throw new SyntaxError(`Invalid literal in WHERE clause: ${valStr}`);
                }
            }
            where = { column: colName, operator: IndexConstraintOp.EQ, value: value };
        }

        return {
            type: 'SELECT',
            columns: columns,
            fromTable: tableName,
            fromSchema: null, // Assume 'main'/'temp' search for now
            whereClause: where
        };
    }
    // --- End Simulate Parsing ---

    /** @internal */
    private async compile(): Promise<VdbeProgram> {
        if (this.vdbeProgram && !this.needsCompile) { return this.vdbeProgram; }
        if (this.finalized) { throw new MisuseError("Statement finalized"); }
        console.log("Compiling statement...");
        this.vdbeProgram = null;

        const ast = this.simulateParse();
        const builder = new VdbeProgramBuilder(this.sql);
        let currentReg = 1; // Start VDBE registers at 1 (0 often special)
        const vtabArgsRegisters: { constraintIndex: number, registerIndex: number }[] = []; // Track constraint -> register

        // Resolve Table Schema
        const tableSchema = this.db._findTable(ast.fromTable, ast.fromSchema);
        if (!tableSchema) { throw new SqliteError(`No such table: ${ast.fromTable}`, StatusCode.ERROR); }
        if (!tableSchema.isVirtual || !tableSchema.vtabModule || !tableSchema.vtabInstance) {
            throw new SqliteError(`Table ${ast.fromTable} is not a ready virtual table`, StatusCode.ERROR);
        }

        // Prepare for xBestIndex
        const constraints: IndexConstraint[] = [];
        const constraintUsage: IndexConstraintUsage[] = [];
        builder.setRequiredMemCells(1); // Need at least one register

        // Process WHERE clause (simplified)
        if (ast.whereClause) {
            const colIndex = tableSchema.columnIndexMap.get(ast.whereClause.column.toLowerCase());
            if (colIndex === undefined) {
                throw new SqliteError(`No such column in ${tableSchema.name}: ${ast.whereClause.column}`, StatusCode.ERROR);
            }
            const constraint: IndexConstraint = { iColumn: colIndex, op: ast.whereClause.operator, usable: true };
            constraints.push(constraint);
            constraintUsage.push({ argvIndex: 0, omit: false }); // Placeholder usage

            const constraintValue = ast.whereClause.value;
            const valueReg = currentReg++; // Allocate register for the value
            builder.setRequiredMemCells(valueReg + 1);

            if (isParameter(constraintValue)) { // Use type guard
                 builder.registerParameter(constraintValue.key, valueReg); // Map parameter to register
                 vtabArgsRegisters.push({ constraintIndex: constraints.length - 1, registerIndex: valueReg });
                 // Value will be placed in valueReg by Vdbe.applyBindings
            } else { // It's a literal SqlValue
                const constIdx = builder.addConstant(constraintValue);
                // Generate instruction to load literal into register
                 switch (typeof constraintValue) {
                    case 'string':
                        builder.addInstruction(createInstruction(Opcode.String8, 0, valueReg, 0, constIdx)); break;
                    case 'number':
                        // Use Integer for simplicity, Real would need check/different opcode
                        builder.addInstruction(createInstruction(Opcode.Integer, constraintValue, valueReg)); break;
                    case 'bigint':
                        builder.addInstruction(createInstruction(Opcode.Int64, 0, valueReg, 0, constIdx)); break;
                     case 'boolean': // Convert boolean to integer 0 or 1
                         builder.addInstruction(createInstruction(Opcode.Integer, constraintValue ? 1 : 0, valueReg)); break;
                    case 'object':
                        if (constraintValue === null) {
                            builder.addInstruction(createInstruction(Opcode.Null, 0, valueReg)); break;
                        } else if (constraintValue instanceof Uint8Array) {
                            builder.addInstruction(createInstruction(Opcode.Blob, 0, valueReg, 0, constIdx)); break;
                        }
                        // Fallthrough intentional for unknown object types? Maybe error?
                    default:
                        throw new SqliteError(`Unsupported literal type in WHERE: ${typeof constraintValue}`, StatusCode.ERROR);
                 }
                 vtabArgsRegisters.push({ constraintIndex: constraints.length - 1, registerIndex: valueReg });
            }
        }

        // Call xBestIndex
        const indexInfo: IndexInfo = {
            nConstraint: constraints.length,
            aConstraint: constraints,
            nOrderBy: 0,
            aOrderBy: [],
            colUsed: BigInt("0xFFFFFFFFFFFFFFFF"),
            aConstraintUsage: constraintUsage,
            idxNum: 0,
            idxStr: null,
            orderByConsumed: false,
            estimatedCost: 1000000,
            estimatedRows: BigInt(1000000),
            idxFlags: 0,
        };
        const bestIndexStatus = tableSchema.vtabInstance.module.xBestIndex(tableSchema.vtabInstance, indexInfo);
        if (bestIndexStatus !== StatusCode.OK) {
            throw new SqliteError(`Virtual table ${tableSchema.name} xBestIndex failed`, bestIndexStatus);
        }

        // Determine Result Columns
        let resultColumns: { name: string, index: number }[] = [];
        if (ast.columns.length === 1 && ast.columns[0].type === 'all') {
            resultColumns = tableSchema.columns.filter(c => !c.hidden).map((c, i) => ({ name: c.name, index: i }));
        } else {
            ast.columns.forEach(selCol => {
                if (selCol.type === 'column') {
                    const colIndex = tableSchema.columnIndexMap.get(selCol.name.toLowerCase());
                    if (colIndex === undefined) {
                        throw new SqliteError(`No such column in ${tableSchema.name}: ${selCol.name}`, StatusCode.ERROR);
                    }
                    resultColumns.push({ name: tableSchema.columns[colIndex].name, index: colIndex }); // Use actual case name
                } else {
                     throw new SqliteError(`Compiler only supports '*' or column names currently`, StatusCode.INTERNAL);
                }
            });
        }
        const numResultColumns = resultColumns.length;
        const resultColumnNames = resultColumns.map(rc => rc.name);
        builder.setColumnNames(resultColumnNames);

        // Generate VDBE Code
        const cursorIdx = 0;
        builder.setRequiredCursors(1);

        // Allocate registers for VFilter args (if any) and results
        let regArgsStart = currentReg; // Next available register
        const argRegisters = new Map<number, number>(); // Map argvIndex to register index
        let filterNArgs = 0;
        indexInfo.aConstraintUsage.forEach((usage, i) => {
            if (usage.argvIndex > 0) {
                const argReg = currentReg++;
                argRegisters.set(usage.argvIndex - 1, argReg); // Store 0-based argvIndex mapping
                filterNArgs = Math.max(filterNArgs, usage.argvIndex);
                // Find original register for this constraint
                const sourceRegInfo = vtabArgsRegisters.find(r => r.constraintIndex === i);
                if (!sourceRegInfo) throw new Error("Internal compiler error: cannot find source register for constraint");
                // Copy value from its original register to the argument register
                builder.addInstruction(createInstruction(Opcode.SCopy, sourceRegInfo.registerIndex, argReg));
            }
        });
        builder.setRequiredMemCells(currentReg); // Update max register needed so far

        const regResultStart = currentReg; // Results start after args
        builder.setRequiredMemCells(regResultStart + numResultColumns);

        // --- Start actual VDBE program ---
        const addrInit = builder.getCurrentAddress();
        builder.addInstruction(createInstruction(Opcode.Init, 0, addrInit + 1)); // Jump over Init on subsequent runs

        // --- Open Cursor ---
        builder.addInstruction(createInstruction(Opcode.OpenRead, cursorIdx, 0, 0, tableSchema)); // Pass TableSchema in P4

        // --- Filtering ---
        const addrFilter = builder.getCurrentAddress();
        // Estimate EOF address (will be backpatched)
        // Calculation: VFilter + N*VColumn + ResultRow + VNext + Goto = 5 + N
        const addrEOFEstimate = addrFilter + 5 + numResultColumns;
        const filterInfo = {
             idxNum: indexInfo.idxNum,
             idxStr: indexInfo.idxStr,
             nArgs: filterNArgs
        };
        // VFilter needs the STARTING register for args (regArgsStart), P4 has the count (filterNArgs)
        builder.addInstruction(createInstruction(Opcode.VFilter, cursorIdx, addrEOFEstimate, regArgsStart, filterInfo));

        // --- Loop Body ---
        const addrLoopStart = builder.getCurrentAddress();
        // Load result columns into registers
        for (let i = 0; i < numResultColumns; i++) {
             const colSchemaIndex = resultColumns[i].index;
             const destReg = regResultStart + i;
             builder.addInstruction(createInstruction(Opcode.VColumn, cursorIdx, colSchemaIndex, destReg));
        }
        // Yield the row
        builder.addInstruction(createInstruction(Opcode.ResultRow, regResultStart, numResultColumns));

        // --- Next ---
        const addrNext = builder.getCurrentAddress();
        builder.addInstruction(createInstruction(Opcode.VNext, cursorIdx, addrEOFEstimate)); // Jump to EOF on end

        // --- Loop ---
        builder.addInstruction(createInstruction(Opcode.Goto, 0, addrLoopStart)); // Loop back to VColumn

        // --- EOF Target ---
        const addrEOFActual = builder.getCurrentAddress();
        builder.updateInstructionP2(addrFilter, addrEOFActual); // Backpatch VFilter jump
        builder.updateInstructionP2(addrNext, addrEOFActual);   // Backpatch VNext jump

        // --- Cleanup ---
        builder.addInstruction(createInstruction(Opcode.Close, cursorIdx)); // Close the cursor

        // --- Halt ---
        builder.addInstruction(createInstruction(Opcode.Halt));

        // --- Finalize ---
        this.vdbeProgram = builder.build();
        this.needsCompile = false;
        console.log("Compilation complete.");
        console.log("Generated Program:", this.vdbeProgram.instructions.map(i => `${Opcode[i.opcode]} ${i.p1} ${i.p2} ${i.p3} ${i.p4 !== null ? ` P4:${JSON.stringify(i.p4)}` : ''}`).join('\n'));
        return this.vdbeProgram;
    }

    /**
     * Binds a value to a parameter index (1-based) or name.
     * Implementation for both overloads.
     */
    bind(key: number | string, value: SqlValue): this {
         if (this.finalized) throw new MisuseError("Statement finalized");
         if (this.busy) throw new MisuseError("Statement busy");
         // Binding might require re-compilation in complex cases, but not for this simple compiler
         // this.needsCompile = true;
         if (typeof key === 'number') {
            if (key < 1 ) throw new RangeError(`Parameter index ${key} out of range (must be >= 1)`);
            this.boundParameters.set(key, value);
         } else if (typeof key === 'string') {
            this.boundParameters.set(key, value);
         } else {
             throw new MisuseError("Invalid parameter key type");
         }
         // If VDBE exists, potentially apply binding immediately? Or let step handle it.
         if (this.vdbe) {
            this.vdbe.applyBindings(this.boundParameters); // Re-apply all? Or just one?
         }
         return this;
     }


    /**
     * Executes the next step of the prepared statement.
     * @returns A Promise resolving to a StatusCode (ROW, DONE, or an error code).
     * @throws MisuseError if the statement is finalized.
     */
    async step(): Promise<StatusCode> {
        if (this.finalized) throw new MisuseError("Statement finalized");
        await this.compile();
        if (!this.vdbeProgram) throw new SqliteError("Compilation failed", StatusCode.INTERNAL);
        if (!this.vdbe) {
             this.vdbe = new Vdbe(this, this.vdbeProgram);
             this.vdbe.applyBindings(this.boundParameters); // Apply initial bindings
        }
        this.busy = true;
        this.currentRowInternal = null;
        const status = await this.vdbe.run();
        if (status !== StatusCode.ROW) { this.busy = false; }
        console.log(`Step result: ${StatusCode[status]}`);
        return status;
    }

    /** @internal Called by VDBE ResultRow opcode */
    _setCurrentRow(memCells: MemoryCell[]): void {
        // Store the raw memory cells for potential later type/subtype access
        this.currentRowInternal = memCells;
        // Could also extract simple values here if preferred
    }


    /**
     * Retrieves all column values for the current row as an array.
     * Should only be called after step() returns ROW.
     * @returns An array of SqlValue.
     * @throws MisuseError if step() did not return ROW.
     */
    get(): SqlValue[] {
        if (this.finalized) throw new MisuseError("Statement finalized");
        if (!this.currentRowInternal) throw new MisuseError("No row available");
        return this.currentRowInternal.map(cell => cell.value);
    }

    /**
     * Retrieves all column values for the current row as an object
     * with column names as keys.
     * Should only be called after step() returns ROW.
     * @returns An object mapping column names to values.
     * @throws MisuseError if step() did not return ROW or if column names are not available.
     */
    getAsObject(): Record<string, SqlValue> {
         if (this.finalized) throw new MisuseError("Statement finalized");
         if (!this.currentRowInternal) throw new MisuseError("No row available");
         const names = this.vdbeProgram?.columnNames || []; // Get names from program
         if (names.length === 0 && this.currentRowInternal.length > 0) {
             // Fallback if compiler didn't set names (should not happen ideally)
             return this.currentRowInternal.reduce((acc, cell, i) => {
                 acc[`col_${i}`] = cell.value;
                 return acc;
             }, {} as Record<string, SqlValue>);
         }
         if (names.length !== this.currentRowInternal.length) {
              throw new SqliteError(`Column name/value count mismatch (${names.length} vs ${this.currentRowInternal.length})`, StatusCode.INTERNAL);
         }
         const obj: Record<string, SqlValue> = {};
         for (let i = 0; i < names.length; i++) {
            const name = names[i];
            if (!(name in obj)) { obj[name] = this.currentRowInternal[i].value; }
         }
         return obj;
    }


    /**
     * Gets the names of the columns in the result set.
     * Available after the first successful step() call that returns ROW or after compilation.
     * @returns An array of column names.
     */
    getColumnNames(): string[] {
        if (this.finalized) throw new MisuseError("Statement finalized");
        // Compile if needed to get column names
        if (this.needsCompile && !this.vdbeProgram) {
            // This path is tricky - compile is async, but this method is sync.
            // Require step() to be called first, or make this async?
            // Let's assume compile was called or names are available from program.
            console.warn("Fetching column names might require prior step() or compilation");
        }
        return [...(this.vdbeProgram?.columnNames || [])];
    }

    /**
     * Resets the prepared statement to its initial state, ready to be re-executed.
     * Retains bound parameter values.
     * @returns A Promise resolving on completion.
     * @throws MisuseError if the statement is finalized.
     */
    async reset(): Promise<void> {
        if (this.finalized) throw new MisuseError("Statement finalized");
        if (this.vdbe) { await this.vdbe.reset(); } // Wait for cursor closing
        this.currentRowInternal = null;
        this.busy = false;
        this.needsCompile = false; // Program is still valid
    }

    /**
     * Clears all bound parameter values, setting them to NULL.
     * @returns This statement instance for chaining.
     * @throws MisuseError if the statement is finalized or busy.
     */
    clearBindings(): this {
        if (this.finalized) throw new MisuseError("Statement finalized");
        if (this.busy) throw new MisuseError("Statement busy - reset first");
        this.boundParameters.clear();
        if (this.vdbe) { this.vdbe.clearAppliedBindings(); }
        return this;
    }

    /**
     * Finalizes the statement, releasing associated resources.
     * This statement instance should not be used after calling finalize.
     * @returns A promise resolving on completion.
     */
    async finalize(): Promise<void> {
        if (this.finalized) return;
        this.finalized = true;
        this.busy = false;
        if (this.vdbe) { await this.vdbe.reset(); } // Ensure cursors are closed
        this.boundParameters.clear();
        this.currentRowInternal = null;
        this.vdbeProgram = null;
        this.vdbe = null;
        this.db._statementFinalized(this);
    }

    // TODO: Add methods like getParameterCount(), getParameterName(), getParameterIndex() if needed
    // TODO: Add sqlite3_column_* equivalent methods if direct column access is desired beyond get()/getAsObject()

}