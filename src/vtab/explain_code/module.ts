import { SqliterError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import type { VirtualTableModule } from '../module.js';
import { ExplainProgramTable } from './table.js';

export class ExplainProgramModule implements VirtualTableModule<ExplainProgramTable, { sql: string }> {

    constructor() { }

    xCreate(): ExplainProgramTable {
        throw new SqliterError(`Cannot CREATE TABLE using module 'vdbe_program'`, StatusCode.ERROR);
    }

    xConnect(
        db: Database,
        pAux: unknown,
        moduleName: string,
        schemaName: string,
        tableName: string,
        options: { sql: string }
    ): ExplainProgramTable {

        if (!options || typeof options.sql !== 'string') {
            throw new SqliterError(`Module '${moduleName}' requires one argument: the SQL string to explain.`, StatusCode.ERROR);
        }

        try {
             // OLD COMPILATION LOGIC REMOVED
             // Return a table instance with an empty program or indication of being stubbed.
             // The VdbeProgramTable will be modified to handle this.
             return new ExplainProgramTable(db, this, { instructions: [], plannedSteps: [] }); // Pass a dummy/empty program
        } catch (e: any) {
            // This catch might not be reached if compilation is removed, but kept for safety.
            throw new SqliterError(`Failed to connect to vdbe_program: ${e.message}`, StatusCode.ERROR, e);
        }
    }

    xDisconnect(table: ExplainProgramTable): void { }

    async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> { }

    xBestIndex(): number {
        return StatusCode.OK;
    }
}
