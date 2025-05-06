import { VirtualTable } from '../table.js';
import type { VdbeProgramModule } from './module.js';
import type { Database } from '../../core/database.js';
import { VDBE_PROGRAM_SCHEMA } from './schema.js'; // Import schema
import { VdbeProgramCursor } from './cursor.js';
import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/constants.js';
import { VirtualTableCursor } from '../cursor.js';
import type { VdbeProgram } from '../../vdbe/program.js';
import type { TableSchema } from '../../schema/table.js'; // Import TableSchema

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

    async xOpen(): Promise<VirtualTableCursor<this>> {
        return new VdbeProgramCursor(this) as unknown as VirtualTableCursor<this>;
    }

    // Implement required abstract methods
    async xDisconnect(): Promise<void> {}

    async xUpdate(): Promise<{ rowid?: bigint; }> {
        throw new SqliteError("Cannot modify vdbe_program table", StatusCode.READONLY);
    }
}
