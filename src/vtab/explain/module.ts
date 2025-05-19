import { SqliterError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import type { QueryPlanStep } from '../../core/explain.js';
import { buildColumnIndexMap, type TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import type { VirtualTableModule } from '../module.js';
import { QueryPlanTable } from './table.js';
import { SqlDataType } from '../../common/types.js';

// Define the fixed schema for the query_plan function
const QUERY_PLAN_COLUMNS: ReadonlyArray<ColumnSchema> = Object.freeze([
    { name: 'id', affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'parent_id', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'subquery_level', affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'op', affinity: SqlDataType.TEXT, notNull: true, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'detail', affinity: SqlDataType.TEXT, notNull: true, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'object_name', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'alias', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'est_cost', affinity: SqlDataType.REAL, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'est_rows', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'idx_num', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'idx_str', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'ord_consumed', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null }, // 0 for false, 1 for true
    { name: 'constraints_desc', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'orderby_desc', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'join_type', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'is_correlated', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, hidden: false, collation: 'BINARY', generated: false, defaultValue: null }, // 0 for false, 1 for true
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


export class QueryPlanModule implements VirtualTableModule<QueryPlanTable, { sql: string }> {

    constructor() { }

    xCreate(): QueryPlanTable {
        throw new SqliterError(`Cannot CREATE TABLE using module 'query_plan'`, StatusCode.ERROR);
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
            throw new SqliterError(`Module '${moduleName}' requires one argument: the SQL string to explain.`, StatusCode.ERROR);
        }

        const sqlToExplain = options.sql;
        let planSteps: QueryPlanStep[];

        try {
             planSteps = db.getPlanInfo(sqlToExplain);
        } catch (e: any) {
            throw new SqliterError(`Failed to generate plan for SQL: ${e.message}`, StatusCode.ERROR, e);
        }

        return new QueryPlanTable(db, this, tableName, QUERY_PLAN_SCHEMA, planSteps);
    }

    xDisconnect(table: QueryPlanTable): void { }

    async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> { }

    xBestIndex(): number {
        return StatusCode.OK;
    }
}
