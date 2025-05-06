// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { SqliteError } from '../../common/errors.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { StatusCode } from '../../common/constants.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Database, QueryPlanStep } from '../../core/database.js';
import { buildColumnIndexMap, type TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import type { VirtualTableModule } from '../module.js';
import { QueryPlanTable } from './table.js';
import { QueryPlanCursor } from './cursor.js';
import { SqlDataType } from '../../common/types.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Parser } from '../../parser/parser.js';

// Define the fixed schema for the query_plan function
const QUERY_PLAN_COLUMNS: ReadonlyArray<ColumnSchema> = Object.freeze([
    { name: 'selectid', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'order', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'from', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'detail', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
]);

const QUERY_PLAN_SCHEMA: TableSchema = Object.freeze({
    name: 'query_plan',
    schemaName: 'main',
    columns: [...QUERY_PLAN_COLUMNS],
    columnIndexMap: buildColumnIndexMap(QUERY_PLAN_COLUMNS),
    primaryKeyDefinition: [],
    checkConstraints: [],
    indexes: [],
    vtabModule: null as any,
    vtabModuleName: 'query_plan',
    vtabAuxData: undefined,
    vtabArgs: [],
    isTemporary: true,
    isView: false,
    isStrict: false,
    isWithoutRowid: true,
    subqueryAST: undefined,
}) as TableSchema;


export class QueryPlanModule implements VirtualTableModule<QueryPlanTable, QueryPlanCursor, { sql: string }> {

    constructor() { }

    xCreate(): QueryPlanTable {
        throw new SqliteError(`Cannot CREATE TABLE using module 'query_plan'`, StatusCode.ERROR);
    }

    xConnect(
        db: Database,
        pAux: unknown,
        moduleName: string,
        schemaName: string,
        tableName: string,
        options: { sql: string }
    ): QueryPlanTable {

        if (!options || typeof options.sql !== 'string') {
            throw new SqliteError(`Module '${moduleName}' requires one argument: the SQL string to explain.`, StatusCode.ERROR);
        }

        const sqlToExplain = options.sql;
        let planSteps: QueryPlanStep[];

        try {
             planSteps = db.getPlanInfo(sqlToExplain);
        } catch (e: any) {
            throw new SqliteError(`Failed to generate plan for SQL: ${e.message}`, StatusCode.ERROR, e);
        }

        return new QueryPlanTable(db, this, tableName, QUERY_PLAN_SCHEMA, planSteps);
    }

    xDisconnect(table: QueryPlanTable): void { }

    async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> { }

    xBestIndex(): number {
        return StatusCode.OK;
    }
}
