import { BTree } from 'digitree';
import type { TableSchema, IndexSchema } from '../../../schema/table.js';
import type { MemoryTableRow, BTreeKey } from '../types.js'; // Updated import path
import type { Layer, ModificationValue } from './interface.js';
import { DELETED } from './constants.js';
import { MemoryIndex } from '../index.js'; // Assuming MemoryIndex structure remains similar
import { isDeletionMarker } from './interface.js'; // Import type guard
import { compareSqlValues } from '../../../util/comparison.js'; // Import for comparison

let baseLayerCounter = 0;

/**
 * Represents the foundational, fully collapsed data layer for a MemoryTable.
 * It holds the primary B-tree and all secondary index B-trees containing
 * the current "ground truth" data after all possible layer collapses.
 */
export class BaseLayer implements Layer {
	private readonly layerId: number;
	public readonly tableSchema: TableSchema; // Made public
	public primaryTree: BTree<BTreeKey, MemoryTableRow>; // Changed from readonly to allow replacement
	public readonly secondaryIndexes: Map<string, MemoryIndex>; // Use MemoryIndex to encapsulate BTree+metadata
	private readonly emptyDeletedSet: ReadonlySet<bigint>;
	public readonly keyFromEntry: (row: MemoryTableRow) => BTreeKey; // Made public
	public readonly compareKeys: (a: BTreeKey, b: BTreeKey) => number; // Made public
	public readonly rowidToKeyMap: Map<bigint, BTreeKey> | null; // Store the map

	constructor(
		schema: TableSchema,
		keyFromEntry: (row: MemoryTableRow) => BTreeKey,
		compareKeys: (a: BTreeKey, b: BTreeKey) => number,
		columns: ReadonlyArray<{ name: string }>, // Needed for MemoryIndex constructor
		needsRowidMap: boolean // Explicitly control map creation
	) {
		this.layerId = baseLayerCounter++;
		this.tableSchema = schema;
		this.keyFromEntry = keyFromEntry;
		this.compareKeys = compareKeys;
		this.primaryTree = new BTree<BTreeKey, MemoryTableRow>(keyFromEntry, compareKeys);
		this.secondaryIndexes = new Map();
		this.emptyDeletedSet = Object.freeze(new Set<bigint>());
		this.rowidToKeyMap = needsRowidMap ? new Map() : null;

		// Initialize secondary index structures based on schema
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				try {
					// Adapt IndexSpec from IndexSchema if needed
					const indexSpec: ConstructorParameters<typeof MemoryIndex>[0] = {
						name: indexSchema.name,
						columns: indexSchema.columns // Assuming MemoryIndex constructor can take this directly now
					};
					const memoryIndex = new MemoryIndex(indexSpec, columns);
					this.secondaryIndexes.set(indexSchema.name, memoryIndex);
				} catch (e) {
					console.error(`BaseLayer: Failed to initialize secondary index '${indexSchema.name}'`, e);
					// Depending on requirements, might want to throw or just log
				}
			}
		}
	}

	getLayerId(): number {
		return this.layerId;
	}

	getParent(): Layer | null {
		return null; // Base layer has no parent
	}

	getModificationTree(indexName: string | 'primary'): BTree<BTreeKey, MemoryTableRow> | null {
		// BaseLayer doesn't store modifications per se, but cursors might need access to the primary tree.
		// Return primary tree for 'primary', null for secondary indexes via this interface method.
		// Specific secondary tree access should use getSecondaryIndexTree.
		return indexName === 'primary' ? this.primaryTree : null;
	}

	getSecondaryIndexTree(indexName: string): BTree<[BTreeKey, bigint], [BTreeKey, bigint]> | null {
		return this.secondaryIndexes.get(indexName)?.data ?? null;
	}


	getDeletedRowids(): ReadonlySet<bigint> {
		// Base layer doesn't track deletions distinctly; deletions are applied directly.
		return this.emptyDeletedSet;
	}

	getSchema(): TableSchema {
		return this.tableSchema;
	}

	isCommitted(): boolean {
		// The base layer is implicitly always committed.
		return true;
	}

	/**
	 * Directly applies a committed change from a TransactionLayer during collapse.
	 * This should only be called under the MemoryTable's management lock.
	 *
	 * @param key The primary key of the row being modified.
	 * @param value The new value (MemoryTableRow) or DELETED symbol.
	 * @param oldEffectiveValue The value of the row *before* this change was applied (needed for secondary index updates).
	 * @returns void
	 * @throws Error on BTree operation failure.
	 */
	applyChange(key: BTreeKey, value: ModificationValue, oldEffectiveValue: MemoryTableRow | null): void {
		const isDelete = isDeletionMarker(value);
		const newValue = isDelete ? null : value; // Row data or null if deleting
		const oldValue = oldEffectiveValue; // Row data before change, or null if it was an insert

		// 1. Update Secondary Indexes (Needs old and new values)
		for (const [indexName, index] of this.secondaryIndexes.entries()) {
			try {
				if (oldValue) {
					// If there was an old value, try removing its index entry
					index.removeEntry(oldValue);
				}
				if (newValue) {
					// If there is a new value (not a delete), add its index entry
					index.addEntry(newValue);
				}
			} catch (e) {
				// This is critical during collapse. Needs robust handling.
				// Possibility: Mark table as corrupt? Halt collapse? Log detailed error.
				console.error(`BaseLayer applyChange: Failed to update secondary index '${indexName}' for key ${JSON.stringify(key)}. Data might be inconsistent.`, e);
				// Re-throwing might be necessary to signal failure of collapse
				throw new Error(`Secondary index update failed during layer collapse: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// 2. Update Primary Index
		try {
			const path = this.primaryTree.find(key);
			if (isDelete) {
				if (path.on) {
					const deletedRow = this.primaryTree.at(path);
					this.primaryTree.deleteAt(path);
					// Update rowidToKeyMap if necessary (handled by MemoryTable during collapse)
					if (this.rowidToKeyMap && deletedRow) {
						this.rowidToKeyMap.delete(deletedRow._rowid_);
					}
				} else {
					// Trying to delete a key that doesn't exist in the base. This might
					// happen if the change originated from an insert+delete in the merged layer.
					// Usually a no-op for the primary tree, but log a warning.
					console.warn(`BaseLayer applyChange: Attempted to delete non-existent primary key ${JSON.stringify(key)} during collapse.`);
				}
			} else if (newValue) { // newValue is guaranteed to be MemoryTableRow here
				if (path.on) {
					// Key exists, update it
					this.primaryTree.updateAt(path, newValue);
					// rowidToKeyMap should already be correct if key didn't change (which it shouldn't for updateAt)
				} else {
					// Key doesn't exist, insert it
					this.primaryTree.insert(newValue);
					// Update rowidToKeyMap if necessary (handled by MemoryTable during collapse)
					if (this.rowidToKeyMap) {
						this.rowidToKeyMap.set(newValue._rowid_, key);
					}
				}
			}
		} catch (e) {
			// Failure here is also critical.
			console.error(`BaseLayer applyChange: Failed to update primary tree for key ${JSON.stringify(key)}. Data might be inconsistent.`, e);
			throw new Error(`Primary index update failed during layer collapse: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Adds a column to all rows in the base layer tables.
	 * This should be called under a schema change lock.
	 *
	 * @param columnName Name of the new column to add
	 * @param defaultValue Default value to use for the new column in existing rows
	 */
	addColumnToBase(columnName: string, defaultValue: any): void {
		// Iterate through all rows in the BTree and add the new column with default value
		const rowsToUpdate: MemoryTableRow[] = [];

		// Collect all rows first
		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const row = this.primaryTree.at(path);
			if (row) {
				rowsToUpdate.push(row);
			}
		}

		// Create a new BTree instance instead of clearing
		const newTree = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);

		// Insert all rows with the new column into the new tree
		for (const row of rowsToUpdate) {
			const updatedRow = { ...row, [columnName]: defaultValue };
			newTree.insert(updatedRow);

			// No need to update rowid mapping as the keys should remain the same
		}

		// Replace the old tree with the new one
		this.primaryTree = newTree;

		// No need to update secondary indexes as they're based on existing columns
		// The column didn't exist before so no index would reference it

		console.debug(`BaseLayer: Added column '${columnName}' to ${rowsToUpdate.length} rows with default value ${defaultValue}`);
	}

	/**
	 * Removes a column from all rows in the base layer tables.
	 * This should be called under a schema change lock.
	 *
	 * @param columnName Name of the column to remove
	 * @returns true if the operation was successful
	 */
	dropColumnFromBase(columnName: string): boolean {
		// Iterate through all rows in the BTree and remove the specified column
		const rowsToUpdate: MemoryTableRow[] = [];

		// Collect all rows first
		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const row = this.primaryTree.at(path);
			if (row) {
				rowsToUpdate.push(row);
			}
		}

		// Create a new BTree instead of clearing the existing one
		const newTree = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);

		// Insert all rows without the dropped column into the new tree
		for (const row of rowsToUpdate) {
			// Create a new row without the specified column
			const { [columnName]: removedValue, ...updatedRow } = row;
			newTree.insert(updatedRow as MemoryTableRow);

			// No need to update rowid mapping as the keys should remain the same
			// unless the column is part of a key, which should be prevented at a higher level
		}

		// Replace the old tree with the new one
		this.primaryTree = newTree;

		// If any secondary indexes were based on this column, they should have been
		// dropped already by the manager before calling this method

		console.debug(`BaseLayer: Removed column '${columnName}' from ${rowsToUpdate.length} rows`);
		return true;
	}

	/**
	 * Renames a column in all rows in the base layer tables.
	 * This should be called under a schema change lock.
	 *
	 * @param oldName Original name of the column
	 * @param newName New name for the column
	 * @returns true if the operation was successful
	 */
	renameColumnInBase(oldName: string, newName: string): boolean {
		// Iterate through all rows in the BTree and rename the specified column
		const rowsToUpdate: MemoryTableRow[] = [];

		// Collect all rows first
		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const row = this.primaryTree.at(path);
			if (row) {
				rowsToUpdate.push(row);
			}
		}

		// Create a new BTree instead of clearing the existing one
		const newTree = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);

		// Insert all rows with the renamed column into the new tree
		for (const row of rowsToUpdate) {
			// Skip if the column doesn't exist in this row
			if (!(oldName in row)) {
				newTree.insert(row);
				continue;
			}

			// Create a new row with the renamed column
			const { [oldName]: value, ...rest } = row;
			const updatedRow = { ...rest, [newName]: value } as MemoryTableRow;
			newTree.insert(updatedRow);

			// No need to update rowid mapping as the keys should remain the same
			// unless the column is part of a key, which should be prevented at a higher level
		}

		// Replace the old tree with the new one
		this.primaryTree = newTree;

		// If any secondary indexes were based on this column, they should have been
		// updated already by the manager before calling this method

		console.debug(`BaseLayer: Renamed column '${oldName}' to '${newName}' in rows`);
		return true;
	}

	/**
	 * Adds a new index to the base layer.
	 * This should be called under a schema change lock.
	 *
	 * @param indexSchema The schema definition for the new index
	 */
	addIndexToBase(indexSchema: IndexSchema): void {
		// Check if the index already exists
		if (this.secondaryIndexes.has(indexSchema.name)) {
			throw new Error(`Index '${indexSchema.name}' already exists in BaseLayer`);
		}

		// Create the MemoryIndex instance for this schema
		const indexSpec: ConstructorParameters<typeof MemoryIndex>[0] = {
			name: indexSchema.name,
			columns: indexSchema.columns
		};

		const memoryIndex = new MemoryIndex(
			indexSpec,
			this.tableSchema.columns.map(c => ({ name: c.name }))
		);

		// Populate the index with existing rows
		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const row = this.primaryTree.at(path);
			if (row) {
				try {
					memoryIndex.addEntry(row);
				} catch (e) {
					console.error(`Failed to add row to new index '${indexSchema.name}':`, e);
					// Consider whether to roll back or continue
				}
			}
		}

		// Store the new index
		this.secondaryIndexes.set(indexSchema.name, memoryIndex);
		console.debug(`BaseLayer: Added and populated index '${indexSchema.name}'`);
	}

	/**
	 * Drops an index from the base layer.
	 * This should be called under a schema change lock.
	 *
	 * @param indexName Name of the index to drop
	 * @returns true if the index was found and dropped, false otherwise
	 */
	dropIndexFromBase(indexName: string): boolean {
		const index = this.secondaryIndexes.get(indexName);
		if (!index) {
			console.warn(`BaseLayer: Attempted to drop non-existent index '${indexName}'`);
			return false;
		}

		// Simply remove the index from the map
		// The BTree inside will be garbage collected
		this.secondaryIndexes.delete(indexName);
		console.debug(`BaseLayer: Dropped index '${indexName}'`);
		return true;
	}

	/**
	 * Checks if the BTree contains a row with the specified key.
	 * Helper method for finding rowids.
	 *
	 * @param key The key to look for
	 * @returns true if the key exists in the BTree
	 */
	has(key: BTreeKey): boolean {
		// Use get instead of has since BTree doesn't have a has method
		return this.primaryTree.get(key) !== undefined;
	}
}
