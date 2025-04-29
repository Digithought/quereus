import type { MemoryTableRow, BTreeKey } from '../types.js'; // Updated import
import type { ModificationKey, ModificationValue } from './interface.js'; // Adjust path

/**
 * Internal interface for cursors that navigate the layer chain for MemoryTable.
 * Implementations handle merging data from their layer with the parent cursor.
 */
export interface LayerCursorInternal {
	/**
	 * Advances the cursor to the next valid entry according to the scan plan,
	 * merging results from the current layer and the parent cursor.
	 * Updates internal state (current key/value, EOF).
	 */
	next(): Promise<void>; // Make next async to handle potential async operations in parents

	/**
	 * Returns the actual data row currently pointed to by the cursor.
	 * Returns null if EOF or if the current entry is a deletion marker
	 * that hasn't been superseded by an insert in a higher layer.
	 */
	getCurrentRow(): MemoryTableRow | null;

	/**
	 * Returns the index-specific key for the entry currently pointed to.
	 * This could be a primary key or a secondary index key ([IndexKey, rowid]).
	 * Returns null if EOF.
	 */
	getCurrentModificationKey(): ModificationKey | null;

	/**
	 * Returns the raw value from the current layer's BTree (could be row or deletion marker).
	 * Used internally for merging logic. May return null if the current item
	 * comes solely from the parent cursor.
	 */
	getCurrentLayerValue(): ModificationValue | null;


	/** Checks if the cursor has reached the end of the merged result set */
	isEof(): boolean;

	/** Releases any resources held by this cursor and its parent cursors */
	close(): void;
}
