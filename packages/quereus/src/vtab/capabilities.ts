import type { SqlValue, Row, CompareFn } from '../common/types.js';

/**
 * Capability flags that modules can advertise to consumers.
 * Used for runtime capability discovery and isolation layer decisions.
 */
export interface ModuleCapabilities {
	/** Module provides transaction isolation (read-your-own-writes, snapshot reads) */
	isolation?: boolean;

	/** Module supports savepoints within transactions */
	savepoints?: boolean;

	/** Module persists data across restarts */
	persistent?: boolean;

	/** Module supports secondary indexes */
	secondaryIndexes?: boolean;

	/** Module supports range scans (not just point lookups) */
	rangeScans?: boolean;
}

/**
 * Extended interface for tables that can be wrapped by the isolation layer.
 * Provides key extraction and comparison functions needed for merge operations.
 */
export interface IsolationCapableTable {
	/**
	 * Extract primary key values from a full row.
	 * The returned array contains only the PK column values in PK order.
	 */
	extractPrimaryKey(row: Row): SqlValue[];

	/**
	 * Compare two rows by their primary key values.
	 * Must use the module's native key ordering (e.g., binary encoding order for store modules).
	 * @returns negative if a < b, 0 if equal, positive if a > b
	 */
	comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number;

	/**
	 * Get a comparator function for a specific index.
	 * Used when merging index scans from overlay and underlying tables.
	 * @param indexName The name of the index
	 * @returns Comparator function, or undefined if index doesn't exist
	 */
	getIndexComparator?(indexName: string): CompareFn | undefined;

	/**
	 * Get the primary key column indices in the row.
	 * Used to extract PK values from rows.
	 */
	getPrimaryKeyIndices(): number[];
}
