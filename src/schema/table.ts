import type { ColumnSchema } from './column.js';
import type { VirtualTableModule } from '../vtab/module.js';
import type { Expression } from '../parser/ast.js';
import { type ColumnDef, type ColumnConstraint, type TableConstraint } from '../parser/ast.js';
import { getAffinity } from './column.js';
import { SqlDataType } from '../common/types.js';
import type * as AST from '../parser/ast.js';

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
	primaryKeyDefinition: ReadonlyArray<{ index: number; desc: boolean }>;
	/** CHECK constraints defined on the table or its columns */
	checkConstraints: ReadonlyArray<{ name?: string, expr: Expression }>;
	/** Whether the table is a virtual table */
	isVirtual: boolean;
	/** If virtual, reference to the registered module */
	vtabModule?: VirtualTableModule<any, any>; // Define specific types later
	/** If virtual, aux data passed during module registration */
	vtabAuxData?: unknown;
	/** If virtual, the arguments passed in CREATE VIRTUAL TABLE */
	vtabArgs?: ReadonlyArray<string>;
	/** If virtual, the name the module was registered with */
	vtabModuleName?: string;
	/** Whether the table is declared WITHOUT ROWID (crucial for VTabs) */
	isWithoutRowid: boolean;
	/** Whether the table is a temporary table */
	isTemporary?: boolean; // Added for subquery sources/temp tables
	/** Whether the table is a strict table */
	isStrict: boolean;
	/** Whether the table is a view */
	isView: boolean;
	/** Whether the table is a subquery source */
	subqueryAST?: AST.SelectStmt; // Added for subquery sources
	/** If virtual, the view definition */
	viewDefinition?: AST.SelectStmt; // Only for views
	/** Table-level constraints */
	tableConstraints?: readonly TableConstraint[];
	/** Definitions of secondary indexes (relevant for planning) */
	indexes?: ReadonlyArray<IndexSchema>;

	// Add flags for other table properties if needed (e.g., isReadOnly, isEphemeral)
}

/** Helper to build the column index map */
export function buildColumnIndexMap(columns: ReadonlyArray<ColumnSchema>): Map<string, number> {
	const map = new Map<string, number>();
	columns.forEach((col, index) => {
		map.set(col.name.toLowerCase(), index);
	});
	return map;
}

/** Helper to find primary key indices and directions */
export function findPrimaryKeyDefinition(columns: ReadonlyArray<ColumnSchema>): ReadonlyArray<{ index: number; desc: boolean }> {
	// Default direction is ASC (false for desc)
	// Currently, ColumnSchema doesn't store direction, assume ASC for real PKs
	// This function is now more relevant for dynamically created sorter schemas.
	const pkCols = columns
		.map((col, index) => ({ ...col, index })) // Add original index
		.filter(col => col.primaryKey) // Filter PK columns
		.sort((a, b) => a.pkOrder - b.pkOrder); // Sort by PK order

	// Assume ASC for standard PKs found via ColumnSchema.primaryKey
	return Object.freeze(pkCols.map(col => ({ index: col.index, desc: false })));
}

/** Helper to extract just the indices from the definition */
export function getPrimaryKeyIndices(pkDef: ReadonlyArray<{ index: number; desc: boolean }>): ReadonlyArray<number> {
	return Object.freeze(pkDef.map(def => def.index));
}

// --- Add columnDefToSchema helper --- //

/**
 * Converts a parsed ColumnDef AST node into a runtime ColumnSchema object.
 * This simplifies creating schemas programmatically or during VTab creation.
 */
export function columnDefToSchema(def: ColumnDef): ColumnSchema {
	const schema: Partial<ColumnSchema> & { name: string } = {
		name: def.name,
		affinity: getAffinity(def.dataType),
		notNull: false,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null, // DefaultValue type is now Expression | null
		collation: 'BINARY', // Default collation
		hidden: false,
		generated: false,
	};

	let pkConstraint: Extract<ColumnConstraint, { type: 'primaryKey' }> | undefined;

	for (const constraint of def.constraints ?? []) {
		switch (constraint.type) {
			case 'primaryKey':
				schema.primaryKey = true;
				// pkOrder needs context of table constraints, handled later if needed
				pkConstraint = constraint as Extract<ColumnConstraint, { type: 'primaryKey' }>;
				// Handle ON CONFLICT for PK
				// schema.notNull = true; // PK implies NOT NULL - Handled below
				break;
			case 'notNull':
				schema.notNull = true;
				// Handle ON CONFLICT for NOT NULL
				break;
			case 'unique':
				// schema.unique = true; // Add if needed
				// Handle ON CONFLICT
				break;
			case 'default':
				schema.defaultValue = constraint.expr; // Assign Expression directly
				break;
			case 'collate':
				schema.collation = constraint.collation;
				break;
			case 'generated':
				schema.generated = true;
				// Store expression? Stored vs Virtual?
				break;
			// CHECK and FOREIGN KEY are typically table constraints or require more context
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
		schema.pkOrder = 1; // Assume order 1 if single PK
	}

	return schema as ColumnSchema;
}
// ------------------------------------ //

// --- Add Index Definition for Schema --- //
export interface IndexColumnSchema {
	index: number;    // Column index in TableSchema.columns
	desc: boolean;
	collation?: string;
}

export interface IndexSchema {
	name: string;
	columns: ReadonlyArray<IndexColumnSchema>;
	// unique?: boolean;
	// where?: Expression; // For partial indexes
}
// -------------------------------------- //

/** Helper to create a basic TableSchema (useful for testing or simple vtabs) */
export function createBasicSchema(name: string, columns: { name: string, type: string }[], pkColNames?: string[]): TableSchema {
	const columnSchemas = columns.map(c => columnDefToSchema({
		name: c.name,
		dataType: c.type,
		constraints: [] // Add empty constraints array
	}));
	const columnIndexMap = buildColumnIndexMap(columnSchemas);
	const pkDef = pkColNames
		? pkColNames.map(pkName => {
			const idx = columnIndexMap.get(pkName.toLowerCase());
			if (idx === undefined) throw new Error(`PK column ${pkName} not found`);
			return { index: idx, desc: false };
		})
		: [];

	return Object.freeze({
		name: name,
		schemaName: 'main',
		columns: columnSchemas,
		columnIndexMap: columnIndexMap,
		primaryKeyDefinition: pkDef,
		checkConstraints: [],
		indexes: [], // Initialize empty
		isVirtual: false,
		vtabModule: undefined, // Use undefined instead of null
		vtabAuxData: null,
		vtabArgs: [],
		isWithoutRowid: false,
		isTemporary: false,
		isStrict: false,
		isView: false,
		subqueryAST: undefined,
		viewDefinition: undefined,
		tableConstraints: [],
	});
}

/** Bitmask for row operations */
export const enum RowOp {
	INSERT = 1,
	UPDATE = 2,
	DELETE = 4
}
export type RowOpMask = RowOp; // Export RowOpMask type
export const DEFAULT_ROWOP_MASK = RowOp.INSERT | RowOp.UPDATE;

// --- Helper to convert AST RowOp[] to RowOpMask --- //
export function opsToMask(list?: AST.RowOp[]): RowOpMask {
	if (!list || list.length === 0) {
		return DEFAULT_ROWOP_MASK; // Default to INSERT | UPDATE
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

/** Interface for a runtime check constraint schema */
export interface RowConstraintSchema {
	name?: string;
	expr: Expression;
	operations: RowOpMask;
}
