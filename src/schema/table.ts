import type { ColumnSchema } from './column.js';
import type { VirtualTableModule } from '../vtab/module.js';
import type { Expression } from '../parser/ast.js';
import { type ColumnDef, type ColumnConstraint, type TableConstraint } from '../parser/ast.js';
import { getAffinity } from './column.js';
import { SqlDataType } from '../common/types.js';
import type * as AST from '../parser/ast.js';
import { MemoryTableModule } from '../vtab/memory/module.js';

/**
 * Represents the schema definition of a table (real or virtual).
 */
export interface TableSchema {
	/** Table name */
	name: string;
	/** Schema name (e.g., "main", "temp") */
	schemaName: string;
	/** Ordered list of column definitions */
	columns: ReadonlyArray<ColumnSchema>;
	/** Map from column name (lowercase) to column index */
	columnIndexMap: ReadonlyMap<string, number>;
	/** Definition of the primary key, including order and direction */
	primaryKeyDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>;
	/** CHECK constraints defined on the table or its columns */
	checkConstraints: ReadonlyArray<{ name?: string, expr: Expression }>;
	/** Reference to the registered module */
	vtabModule: VirtualTableModule<any, any>;
	/** If virtual, aux data passed during module registration */
	vtabAuxData?: unknown;
	/** If virtual, the arguments passed in CREATE VIRTUAL TABLE */
	vtabArgs?: ReadonlyArray<string>;
	/** If virtual, the name the module was registered with */
	vtabModuleName: string;
	/** Whether the table is declared WITHOUT ROWID */
	isWithoutRowid: boolean;
	/** Whether the table is a temporary table */
	isTemporary?: boolean;
	/** Whether the table is a strict table */
	isStrict: boolean;
	/** Whether the table is a view */
	isView: boolean;
	/** Whether the table is a subquery source */
	subqueryAST?: AST.SelectStmt;
	/** If virtual, the view definition */
	viewDefinition?: AST.SelectStmt;
	/** Table-level constraints */
	tableConstraints?: readonly TableConstraint[];
	/** Definitions of secondary indexes (relevant for planning) */
	indexes?: ReadonlyArray<IndexSchema>;
	/** Estimated number of rows in the table (for query planning) */
	readonly estimatedRows?: number;
}

/**
 * Builds a map from column names to their indices in the columns array
 *
 * @param columns Array of column schemas
 * @returns Map of lowercase column names to their indices
 */
export function buildColumnIndexMap(columns: ReadonlyArray<ColumnSchema>): Map<string, number> {
	const map = new Map<string, number>();
	columns.forEach((col, index) => {
		map.set(col.name.toLowerCase(), index);
	});
	return map;
}

/**
 * Extracts primary key information from column definitions
 *
 * @param columns Array of column schemas
 * @returns Array of objects with index and direction for primary key columns
 */
export function findPrimaryKeyDefinition(columns: ReadonlyArray<ColumnSchema>): ReadonlyArray<PrimaryKeyColumnDefinition> {
	const pkCols = columns
		.map((col, index) => ({ ...col, index }))
		.filter(col => col.primaryKey)
		.sort((a, b) => a.pkOrder - b.pkOrder);

	return Object.freeze(pkCols.map(col => ({
		index: col.index,
		desc: false,
		// TODO: there is no autoIncrement in the ColumnSchema
		autoIncrement: (col as any).autoIncrement ?? undefined,
		collation: col.collation ?? 'BINARY'
	})));
}

/**
 * Extracts just the column indices from a primary key definition
 *
 * @param pkDef Primary key definition array
 * @returns Array of column indices that form the primary key
 */
export function getPrimaryKeyIndices(pkDef: ReadonlyArray<PrimaryKeyColumnDefinition>): ReadonlyArray<number> {
	return Object.freeze(pkDef.map(def => def.index));
}

/**
 * Converts a parsed ColumnDef AST node into a runtime ColumnSchema object
 *
 * @param def Column definition AST node
 * @returns A runtime ColumnSchema object
 */
export function columnDefToSchema(def: ColumnDef): ColumnSchema {
	const schema: Partial<ColumnSchema> & { name: string } = {
		name: def.name,
		affinity: getAffinity(def.dataType),
		notNull: false,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY',
		hidden: false,
		generated: false,
	};

	let pkConstraint: Extract<ColumnConstraint, { type: 'primaryKey' }> | undefined;

	for (const constraint of def.constraints ?? []) {
		switch (constraint.type) {
			case 'primaryKey':
				schema.primaryKey = true;
				pkConstraint = constraint as Extract<ColumnConstraint, { type: 'primaryKey' }>;
				break;
			case 'notNull':
				schema.notNull = true;
				break;
			case 'unique':
				break;
			case 'default':
				schema.defaultValue = constraint.expr;
				break;
			case 'collate':
				schema.collation = constraint.collation;
				break;
			case 'generated':
				schema.generated = true;
				break;
		}
	}

	// SQLite rule: If a column has type INTEGER PRIMARY KEY, it maps to rowid
	// Also, PK implies NOT NULL unless it's INTEGER PRIMARY KEY
	if (schema.primaryKey) {
		const isIntegerPk = schema.affinity === SqlDataType.INTEGER && pkConstraint;
		if (!isIntegerPk) {
			schema.notNull = true;
		}
	}

	// Assign a default pkOrder if it's a PK but order isn't specified elsewhere
	if (schema.primaryKey && schema.pkOrder === 0) {
		schema.pkOrder = 1;
	}

	return schema as ColumnSchema;
}

/**
 * Defines a column in an index
 */
export interface IndexColumnSchema {
	/** Column index in TableSchema.columns */
	index: number;
	/** Whether the index should sort in descending order */
	desc: boolean;
	/** Optional collation sequence for the column */
	collation?: string;
}

/**
 * Represents an index definition
 */
export interface IndexSchema {
	/** Index name */
	name: string;
	/** Columns in the index */
	columns: ReadonlyArray<IndexColumnSchema>;
}

/**
 * Creates a basic TableSchema with minimal configuration
 *
 * @param name Table name
 * @param columns Array of column name and type objects
 * @param pkColNames Optional array of primary key column names
 * @returns A frozen TableSchema object
 */
export function createBasicSchema(name: string, columns: { name: string, type: string }[], pkColNames?: string[]): TableSchema {
	const columnSchemas = columns.map(c => columnDefToSchema({
		name: c.name,
		dataType: c.type,
		constraints: []
	}));
	const columnIndexMap = buildColumnIndexMap(columnSchemas);
	const pkDef = pkColNames
		? pkColNames.map(pkName => {
			const idx = columnIndexMap.get(pkName.toLowerCase());
			if (idx === undefined) throw new Error(`PK column ${pkName} not found`);
			return { index: idx, desc: false };
		})
		: [];

	const defaultMemoryModule = new MemoryTableModule();

	return Object.freeze({
		name: name,
		schemaName: 'main',
		columns: columnSchemas,
		columnIndexMap: columnIndexMap,
		primaryKeyDefinition: pkDef,
		checkConstraints: [],
		indexes: [],
		vtabModule: defaultMemoryModule,
		vtabAuxData: null,
		vtabArgs: [],
		vtabModuleName: 'memory',
		isWithoutRowid: false,
		isTemporary: false,
		isStrict: false,
		isView: false,
		subqueryAST: undefined,
		viewDefinition: undefined,
		tableConstraints: [],
	}) as TableSchema;
}

/** Bitmask for row operations */
export const enum RowOp {
	INSERT = 1,
	UPDATE = 2,
	DELETE = 4
}
export type RowOpMask = RowOp;
export const DEFAULT_ROWOP_MASK = RowOp.INSERT | RowOp.UPDATE;

/**
 * Converts an array of row operations to a bitmask
 *
 * @param list Optional array of operation types
 * @returns A bitmask representing the operations
 */
export function opsToMask(list?: AST.RowOp[]): RowOpMask {
	if (!list || list.length === 0) {
		return DEFAULT_ROWOP_MASK;
	}
	let mask: RowOpMask = 0 as RowOpMask;
	list.forEach(op => {
		switch (op) {
			case 'insert': mask |= RowOp.INSERT; break;
			case 'update': mask |= RowOp.UPDATE; break;
			case 'delete': mask |= RowOp.DELETE; break;
		}
	});
	return mask;
}

/**
 * Represents a CHECK constraint with operation flags
 */
export interface RowConstraintSchema {
	/** Optional constraint name */
	name?: string;
	/** Constraint expression */
	expr: Expression;
	/** Bitmask of operations the constraint applies to */
	operations: RowOpMask;
}

export interface PrimaryKeyColumnDefinition {
	index: number;
	desc: boolean;
	autoIncrement?: boolean;
	collation?: string;
}
