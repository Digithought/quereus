import type { SqlValue, Row } from '@quereus/quereus';

/**
 * Comparator function for primary keys.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export type PKComparator = (a: SqlValue[], b: SqlValue[]) => number;

/**
 * Function to extract primary key from a row.
 */
export type PKExtractor = (row: Row) => SqlValue[];

/**
 * Comparator function for sort keys (may be PK, index key, or composite).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export type SortKeyComparator = (a: SqlValue[], b: SqlValue[]) => number;

/**
 * Function to extract sort key from a row.
 * For PK scans, this returns the PK.
 * For secondary index scans, this returns [indexKeyParts..., pkParts...].
 */
export type SortKeyExtractor = (row: Row) => SqlValue[];

/**
 * An entry in the overlay stream.
 * Can be a regular row (insert/update) or a tombstone (delete).
 */
export interface MergeEntry {
	/** The row data (for inserts/updates) or the PK values (for tombstones) */
	row: Row;

	/** If true, this entry represents a deletion */
	tombstone: boolean;

	/** Pre-extracted primary key for efficient comparison */
	pk: SqlValue[];

	/**
	 * Pre-extracted sort key for merge ordering.
	 * For PK scans, this equals pk.
	 * For secondary index scans, this is [indexKeyParts..., pkParts...].
	 */
	sortKey: SqlValue[];
}

/**
 * Configuration for the merge iterator.
 */
export interface MergeConfig {
	/** Compare two primary keys */
	comparePK: PKComparator;

	/** Extract primary key from an underlying row */
	extractPK: PKExtractor;

	/**
	 * Compare two sort keys for merge ordering.
	 * Defaults to comparePK if not provided.
	 * For secondary index scans, compares by index key first, then PK.
	 */
	compareSortKey?: SortKeyComparator;

	/**
	 * Extract sort key from an underlying row.
	 * Defaults to extractPK if not provided.
	 * For secondary index scans, extracts [indexKeyParts..., pkParts...].
	 */
	extractSortKey?: SortKeyExtractor;
}
