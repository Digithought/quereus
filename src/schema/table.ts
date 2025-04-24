import type { ColumnSchema } from './column';
import type { VirtualTableModule } from '../vtab/module';
import type { VirtualTable } from '../vtab/table';
import type { Expression } from '../parser/ast';
import { type ColumnDef, type ColumnConstraint } from '../parser/ast';
import { getAffinity } from './column';
import { SqlDataType } from '../common/types';

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
	/** If virtual, the instantiated table object (after xConnect/xCreate) */
	vtabInstance?: VirtualTable; // Define specific types later
	/** If virtual, aux data passed during module registration */
	vtabAuxData?: unknown;
	/** If virtual, the arguments passed in CREATE VIRTUAL TABLE */
	vtabArgs?: ReadonlyArray<string>;
	/** If virtual, the name the module was registered with */
	vtabModuleName?: string;
	/** Whether the table is declared WITHOUT ROWID (crucial for VTabs) */
	// isWithoutRowid: boolean; // Let's assume VTabs *can* have rowids unless module specifies otherwise

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
