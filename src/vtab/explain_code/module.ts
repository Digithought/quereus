import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import type { VirtualTableModule } from '../module.js';
import { ExplainProgramTable } from './table.js';

export class ExplainProgramModule implements VirtualTableModule<ExplainProgramTable, { sql: string }> {

    constructor() { }

    xCreate(): ExplainProgramTable {
        throw new QuereusError(`Cannot CREATE TABLE using module 'explain_program'`, StatusCode.ERROR);
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
            throw new QuereusError(`Module '${moduleName}' requires one argument: the SQL string to explain.`, StatusCode.ERROR);
        }

        try {
             // OLD COMPILATION LOGIC REMOVED
             return new ExplainProgramTable(db, this, { instructions: [], plannedSteps: [] }); // Pass a dummy/empty program
        } catch (e: any) {
            // This catch might not be reached if compilation is removed, but kept for safety.
            throw new QuereusError(`Failed to connect to explain_program: ${e.message}`, StatusCode.ERROR, e);
        }
    }

    xDisconnect(table: ExplainProgramTable): void { }

    async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> { }

    xBestIndex(): number {
        return StatusCode.OK;
    }
}
