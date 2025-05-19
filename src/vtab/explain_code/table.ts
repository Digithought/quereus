import { VirtualTable } from '../table.js';
import type { ExplainProgramModule } from './module.js';
import type { Database } from '../../core/database.js';
import { VDBE_PROGRAM_SCHEMA } from './schema.js'; // Import schema
import { SqliterError } from '../../common/errors.js';
import { StatusCode, type RowIdRow } from '../../common/types.js'; // Added RowIdRow
// import type { VdbeProgram } from '../../vdbe/program.js'; // REMOVED
// import type { VdbeInstruction } from '../../vdbe/instruction.js'; // REMOVED
import type { TableSchema } from '../../schema/table.js'; // Import TableSchema
// import { safeJsonStringify } from '../../util/serialization.js'; // REMOVED if not used for p4
import type { Row, SqlValue } from '../../common/types.js';
// import { Opcode } from '../../vdbe/opcodes.js'; // REMOVED
import type { FilterInfo } from '../filter-info.js'; // Added FilterInfo

// Dummy VdbeProgram-like type for constructor signature
interface DummyProgram {
    instructions: any[]; // Can be empty
    // Add other VdbeProgram properties if VdbeProgramTable constructor expects them, even if unused.
    plannedSteps?: any[];
}

/**
 * Represents an instance of the vdbe_program virtual table for a specific query.
 */
export class ExplainProgramTable extends VirtualTable {
    public readonly tableSchema = VDBE_PROGRAM_SCHEMA; // Use imported schema
    // public readonly program: VdbeProgram; // Store the dummy program if needed, or remove if truly unused

    /** @internal Use VdbeProgramModule.xConnect */
    constructor(
        db: Database,
        module: ExplainProgramModule,
        program: DummyProgram // Accept dummy program
    ) {
        // Use the fixed schema name, but the function name (passed as tableName) for identification?
        // Let's stick to the schema name for consistency.
        super(db, module as any, VDBE_PROGRAM_SCHEMA.schemaName, VDBE_PROGRAM_SCHEMA.name);
        // this.program = program; // Store if necessary, or can be ignored if table yields no rows
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
        // Stubbed out: yield no rows.
        // The original logic iterated this.program.instructions.
        // For now, we make it a no-op.
        if (false) { // Keep yield for type, but make it unreachable
            yield [] as unknown as RowIdRow;
        }
        return;
    }
}
