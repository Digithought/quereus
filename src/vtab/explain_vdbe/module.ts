import { SqliterError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import type { VirtualTableModule } from '../module.js';
import { VdbeProgramTable } from './table.js';
import { VdbeProgramCursor } from './cursor.js';
import { VDBE_PROGRAM_SCHEMA } from './schema.js';
import { Parser } from '../../parser/parser.js';
import { Compiler } from '../../compiler/compiler.js';

export class VdbeProgramModule implements VirtualTableModule<VdbeProgramTable, VdbeProgramCursor, { sql: string }> {

    constructor() { }

    xCreate(): VdbeProgramTable {
        throw new SqliterError(`Cannot CREATE TABLE using module 'vdbe_program'`, StatusCode.ERROR);
    }

    xConnect(
        db: Database,
        pAux: unknown,
        moduleName: string,
        schemaName: string,
        tableName: string, // This will be the function name used in SQL
        options: { sql: string } // Expect { sql: 'SQL_QUERY' } from VDBE (or handled by compiler)
    ): VdbeProgramTable {

        if (!options || typeof options.sql !== 'string') {
            throw new SqliterError(`Module '${moduleName}' requires one argument: the SQL string to explain.`, StatusCode.ERROR);
        }

        const sqlToExplain = options.sql;

        try {
             // Compile the SQL to get the VDBE program
             const parser = new Parser();
             const ast = parser.parse(sqlToExplain);
             const compiler = new Compiler(db);
             const program = compiler.compile(ast, sqlToExplain);

             // Return the table instance holding the program
             return new VdbeProgramTable(db, this, program);
        } catch (e: any) {
            throw new SqliterError(`Failed to compile SQL for vdbe_program: ${e.message}`, StatusCode.ERROR, e);
        }
    }

    xDisconnect(table: VdbeProgramTable): void { }

    async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> { }

    // BestIndex is trivial as there are no indexes or query constraints
    xBestIndex(): number {
        // Indicate a full sequential scan with no cost
        // No constraints to set
        // No order by consumed
        return StatusCode.OK;
    }
}
