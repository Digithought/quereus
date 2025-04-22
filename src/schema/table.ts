import type { ColumnSchema } from './column';
import type { VirtualTableModule } from '../vtab/module';
import type { VirtualTable } from '../vtab/table';

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
