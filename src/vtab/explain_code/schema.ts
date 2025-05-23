import { buildColumnIndexMap, type TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import { SqlDataType } from '../../common/types.js';

// Define the fixed schema for the vdbe_program function
export const EXPLAIN_PROGRAM_COLUMNS: ReadonlyArray<ColumnSchema> = Object.freeze([
    { name: 'addr',    affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'opcode',  affinity: SqlDataType.TEXT,    notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'p1',      affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'p2',      affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'p3',      affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'p4',      affinity: SqlDataType.TEXT,    notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'p5',      affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false, defaultValue: null },
    { name: 'comment', affinity: SqlDataType.TEXT,    notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false, defaultValue: null },
]);

export const EXPLAIN_PROGRAM_SCHEMA: TableSchema = Object.freeze({
    name: 'explain_program', // Internal name, user calls function name
    schemaName: 'main',
    columns: [...EXPLAIN_PROGRAM_COLUMNS],
    columnIndexMap: buildColumnIndexMap(EXPLAIN_PROGRAM_COLUMNS),
    primaryKeyDefinition: [],
    checkConstraints: [],
    indexes: [],
    vtabModule: null as any, // Set by module constructor/registration if needed
    vtabModuleName: 'explain_program',
    vtabAuxData: undefined,
    vtabArgs: {},
    isTemporary: true,
    isView: false,
    subqueryAST: undefined,
} satisfies TableSchema);
