import { VirtualTable } from '../table.js';
import type { ExplainProgramModule } from './module.js';
import type { Database } from '../../core/database.js';
import { EXPLAIN_PROGRAM_SCHEMA } from './schema.js'; // Import schema
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type RowIdRow } from '../../common/types.js'; // Added RowIdRow
import type { TableSchema } from '../../schema/table.js'; // Import TableSchema
import type { Row, SqlValue } from '../../common/types.js';
import type { FilterInfo } from '../filter-info.js'; // Added FilterInfo

interface DummyProgram {
    instructions: any[]; // Can be empty
    plannedSteps?: any[];
}

/**
 * Represents an instance of the vdbe_program virtual table for a specific query.
 */
export class ExplainProgramTable extends VirtualTable {
    public readonly tableSchema = EXPLAIN_PROGRAM_SCHEMA; // Use imported schema

    /** @internal Use VdbeProgramModule.xConnect */
    constructor(
        db: Database,
        module: ExplainProgramModule,
        program: DummyProgram // Accept dummy program
    ) {
        // Use the fixed schema name, but the function name (passed as tableName) for identification?
        // Let's stick to the schema name for consistency.
        super(db, module as any, EXPLAIN_PROGRAM_SCHEMA.schemaName, EXPLAIN_PROGRAM_SCHEMA.name);
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
        throw new QuereusError("Cannot modify explain_program table", StatusCode.READONLY);
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
