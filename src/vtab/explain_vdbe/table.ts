import { VirtualTable } from '../table.js';
import type { VdbeProgramModule } from './module.js';
import type { Database } from '../../core/database.js';
import { VDBE_PROGRAM_SCHEMA } from './schema.js'; // Import schema
import { SqliterError } from '../../common/errors.js';
import { StatusCode, type RowIdRow } from '../../common/types.js'; // Added RowIdRow
import type { VdbeProgram } from '../../vdbe/program.js';
import type { VdbeInstruction } from '../../vdbe/instruction.js'; // Corrected import path
import type { TableSchema } from '../../schema/table.js'; // Import TableSchema
import { safeJsonStringify } from '../../util/serialization.js';
import type { Row, SqlValue } from '../../common/types.js';
import { Opcode } from '../../vdbe/opcodes.js';
import type { FilterInfo } from '../filter-info.js'; // Added FilterInfo

/**
 * Represents an instance of the vdbe_program virtual table for a specific query.
 */
export class VdbeProgramTable extends VirtualTable {
    public readonly tableSchema = VDBE_PROGRAM_SCHEMA; // Use imported schema
    public readonly program: VdbeProgram;

    /** @internal Use VdbeProgramModule.xConnect */
    constructor(
        db: Database,
        module: VdbeProgramModule,
        program: VdbeProgram // Compiled program passed from module
    ) {
        // Use the fixed schema name, but the function name (passed as tableName) for identification?
        // Let's stick to the schema name for consistency.
        super(db, module as any, VDBE_PROGRAM_SCHEMA.schemaName, VDBE_PROGRAM_SCHEMA.name);
        this.program = program;
    }

    getSchema(): TableSchema {
        return this.tableSchema;
    }

    isReadOnly(): boolean {
        return true; // VDBE program is read-only
    }

    // xOpen removed

    // Implement required abstract methods
    async xDisconnect(): Promise<void> {}

    async xUpdate(): Promise<{ rowid?: bigint; }> {
        throw new SqliterError("Cannot modify vdbe_program table", StatusCode.READONLY);
    }

    async* xQuery(_filterInfo: FilterInfo): AsyncIterable<RowIdRow> {
        // VdbeProgramTable iteration doesn't use filterInfo for filtering.
        // The program is fixed at table connection time.
        for (let i = 0; i < this.program.instructions.length; i++) {
            const currentInstr: VdbeInstruction = this.program.instructions[i];
            const rowId = BigInt(i); // Use address as rowid

            let p4Value: any = currentInstr.p4;
            if (p4Value !== null && typeof p4Value === 'object') {
                try {
                    p4Value = safeJsonStringify(p4Value);
                } catch {
                    p4Value = '[unstringifiable P4]';
                }
            }

            const row: SqlValue[] = [
                i,                                           // addr
                Opcode[currentInstr.opcode],                 // opcode
                currentInstr.p1,                             // p1
                currentInstr.p2,                             // p2
                currentInstr.p3,                             // p3
                p4Value,                                     // p4
                currentInstr.p5,                             // p5
                currentInstr.comment ?? null                 // comment
            ];
            yield [rowId, row];
        }
    }
}
