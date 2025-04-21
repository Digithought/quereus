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
	/** Indices of primary key columns (0-based) */
	primaryKeyColumns: ReadonlyArray<number>;
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

/** Helper to find primary key indices */
export function findPrimaryKeyColumns(columns: ReadonlyArray<ColumnSchema>): number[] {
	return columns
		.map((col, index) => ({ ...col, index })) // Add original index
		.filter(col => col.primaryKey) // Filter PK columns
		.sort((a, b) => a.pkOrder - b.pkOrder) // Sort by PK order
		.map(col => col.index); // Extract original index
}
