import type { BTree } from 'digitree';
import type { TableSchema } from '../../../schema/table.js';
import type { BTreeKey, BTreeKeyForPrimary, BTreeKeyForIndex, PrimaryModificationValue, MemoryIndexEntry } from '../types.js';
import type { Row } from '../../../common/types.js';

/**
 * Represents a snapshot or a set of changes in the MemoryTable MVCC model.
 * Layers form a chain, starting from a BaseLayer.
 */
export interface Layer {
	/** Returns the layer ID (unique identifier, potentially timestamp or sequence) */
	getLayerId(): number;

	/** Returns the parent layer in the chain, or null for the BaseLayer */
	getParent(): Layer | null;

	/**
	 * Gets the BTree containing modifications specific to this layer for a given index.
	 * For BaseLayer, this returns the main data BTree.
	 * For TransactionLayer, this returns the delta BTree for that index.
	 *
	 * @param indexName The name of the secondary index, or 'primary' for the primary key index.
	 * @returns The BTree containing modifications/data for the index in this layer, or null if no modifications exist for that index in this layer.
	 */
	getModificationTree(indexName: string | 'primary'): BTree<BTreeKeyForPrimary, PrimaryModificationValue> | null;

	/**
	 * Returns the table schema as it existed when this layer was created or relevant.
	 * This is important for interpreting modifications during layer collapse, especially
	 * if schema changes occurred after this layer was created.
	 */
	getSchema(): TableSchema;

	/** Indicates if this layer represents a committed transaction state */
	isCommitted(): boolean;

	/** Helper to get the specific BTree for a secondary index's underlying data (relevant for BaseLayer) */
	getSecondaryIndexTree?(indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null;

	/**
	 * This method provides PK extractor and comparator based on a given schema (usually its own)
	 */
	getPkExtractorsAndComparators(schema: TableSchema): {
		primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;
	};
}
