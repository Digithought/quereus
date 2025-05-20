import { BTree } from 'digitree';
import type { TableSchema, IndexSchema } from '../../../schema/table.js';
import type { BTreeKey } from '../types.js';
import type { Layer, ModificationValue } from './interface.js';
import { MemoryIndex } from '../index.js';
import { isDeletionMarker } from './interface.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { createLogger } from '../../../common/logger.js';
import { safeJsonStringify } from '../../../util/serialization.js';
import type { RowIdRow, SqlValue } from '../../../common/types.js';

let baseLayerCounter = 0;
const log = createLogger('vtab:memory:layer:base');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log.extend('debug');

/**
 * Helper function to create the primary key extractor and comparator for BaseLayer.
 */
export function createBaseLayerPkFunctions(schema: TableSchema): {
	keyFromEntry: (rowTuple: RowIdRow) => BTreeKey;
	compareKeys: (a: BTreeKey, b: BTreeKey) => number;
} {
	const pkDef = schema.primaryKeyDefinition ?? [];

	if (pkDef.length === 0) { // Rowid key
		return {
			keyFromEntry: (rowTuple) => rowTuple[0], // rowid is at index 0
			compareKeys: (a, b) => compareSqlValues(a as bigint, b as bigint)
		};
	} else if (pkDef.length === 1) { // Single column PK
		const { index: pkSchemaIndex, desc: isDesc, collation } = pkDef[0];
		return {
			keyFromEntry: (rowTuple) => rowTuple[1][pkSchemaIndex] as BTreeKey,
			compareKeys: (a, b) => {
				const cmp = compareSqlValues(a as SqlValue, b as SqlValue, collation || 'BINARY');
				return isDesc ? -cmp : cmp;
			}
		};
	} else { // Composite PK
		const pkColSchemaIndices = pkDef.map(def => def.index);
		return {
			keyFromEntry: (rowTuple) => pkColSchemaIndices.map(i => rowTuple[1][i]),
			compareKeys: (a, b) => {
				const arrA = a as SqlValue[];
				const arrB = b as SqlValue[];
				for (let i = 0; i < pkDef.length; i++) {
					if (i >= arrA.length || i >= arrB.length) return arrA.length - arrB.length;
					const def = pkDef[i];
					const dirMultiplier = def.desc ? -1 : 1;
					const collation = def.collation || 'BINARY';
					const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
					if (cmp !== 0) return cmp;
				}
				return arrA.length - arrB.length; // Should be 0 if lengths match and all components equal
			}
		};
	}
}

/**
 * Represents the foundational, fully collapsed data layer for a MemoryTable.
 * It holds the primary B-tree and all secondary index B-trees containing
 * the current "ground truth" data after all possible layer collapses.
 */
export class BaseLayer implements Layer {
	private readonly layerId: number;
	public readonly tableSchema: TableSchema;
	public primaryTree: BTree<BTreeKey, RowIdRow>;
	public readonly secondaryIndexes: Map<string, MemoryIndex>;
	private readonly emptyDeletedSet: ReadonlySet<bigint>;
	public readonly keyFromEntry: (rowTuple: RowIdRow) => BTreeKey;
	public readonly compareKeys: (a: BTreeKey, b: BTreeKey) => number;
	public readonly rowidToKeyMap: Map<bigint, BTreeKey> | null;

	constructor(
		schema: TableSchema,
		columnsForSecondaryIdx: ReadonlyArray<{ name: string }>, // Only names needed by MemoryIndex constructor
		needsRowidMap: boolean
	) {
		this.layerId = baseLayerCounter++;
		this.tableSchema = schema;

		const pkFuncs = createBaseLayerPkFunctions(schema);
		this.keyFromEntry = pkFuncs.keyFromEntry;
		this.compareKeys = pkFuncs.compareKeys;

		this.primaryTree = new BTree<BTreeKey, RowIdRow>(this.keyFromEntry, this.compareKeys);
		this.secondaryIndexes = new Map();
		this.emptyDeletedSet = Object.freeze(new Set<bigint>());
		this.rowidToKeyMap = needsRowidMap ? new Map() : null;

		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				try {
					const indexSpec: ConstructorParameters<typeof MemoryIndex>[0] = {
						name: indexSchema.name,
						columns: indexSchema.columns
					};
					// MemoryIndex constructor expects allTableColumns to determine schema indices
					// Here, columnsForSecondaryIdx provides the names, which MemoryIndex uses with its spec.
					// The spec in IndexSchema already contains the *schema indices*.
					const memoryIndex = new MemoryIndex(indexSpec, columnsForSecondaryIdx);
					this.secondaryIndexes.set(indexSchema.name, memoryIndex);
				} catch (e) {
					errorLog(`Failed to initialize secondary index '${indexSchema.name}': %O`, e);
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

	getModificationTree(indexName: string | 'primary'): BTree<BTreeKey, RowIdRow> | null {
		// BaseLayer doesn't store modifications per se, but cursors might need access to the primary tree.
		// Return primary tree for 'primary', null for secondary indexes via this interface method.
		// Specific secondary tree access should use getSecondaryIndexTree.
		return indexName === 'primary' ? this.primaryTree : null;
	}

	getSecondaryIndexTree(indexName: string): BTree<[BTreeKey, bigint], [BTreeKey, bigint]> | null {
		return this.secondaryIndexes.get(indexName)?.data ?? null;
	}


	getDeletedRowids(): ReadonlySet<bigint> {
		// BaseLayer doesn't track deletions distinctly; deletions are applied directly.
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
	 * @param modValue The new value (RowIdRow tuple or DELETED symbol) from the transaction layer.
	 * @param oldEffectiveTuple The value of the row *before* this change was applied (as a RowIdRow tuple or null).
	 * @returns void
	 * @throws Error on BTree operation failure.
	 */
	applyChange(key: BTreeKey, modValue: ModificationValue, oldEffectiveTuple: RowIdRow | null): void {
		const isDelete = isDeletionMarker(modValue);
		const newTuple = isDelete ? null : modValue as RowIdRow; // Row data tuple or null if deleting
		const oldTuple = oldEffectiveTuple; // Row data tuple before change, or null if it was an insert

		// 1. Update Secondary Indexes (Needs old and new tuples)
		for (const [indexName, index] of this.secondaryIndexes.entries()) {
			try {
				if (oldTuple) {
					index.removeEntry(oldTuple);
				}
				if (newTuple) {
					index.addEntry(newTuple);
				}
			} catch (e) {
				errorLog(`applyChange: Failed to update secondary index '${indexName}' for key ${safeJsonStringify(key)}. Data might be inconsistent. Error: %O`, e);
				throw new Error(`Secondary index update failed during layer collapse: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// 2. Update Primary Index
		try {
			const path = this.primaryTree.find(key);
			if (isDelete) {
				if (path.on) {
					const deletedTuple = this.primaryTree.at(path);
					this.primaryTree.deleteAt(path);
					if (this.rowidToKeyMap && deletedTuple) {
						this.rowidToKeyMap.delete(deletedTuple[0]); // rowid from tuple
					}
				} else {
					warnLog(`applyChange: Attempted to delete non-existent primary key %s during collapse.`, safeJsonStringify(key));
				}
			} else if (newTuple) { // newTuple is RowIdRow here
				if (path.on) {
					this.primaryTree.updateAt(path, newTuple);
				} else {
					this.primaryTree.insert(newTuple);
					if (this.rowidToKeyMap) {
						this.rowidToKeyMap.set(newTuple[0], key); // rowid from tuple
					}
				}
			}
		} catch (e) {
			errorLog(`applyChange: Failed to update primary tree for key ${safeJsonStringify(key)}. Data might be inconsistent. Error: %O`, e);
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
		const rowsToUpdate: RowIdRow[] = [];

		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const rowTuple = this.primaryTree.at(path);
			if (rowTuple) {
				rowsToUpdate.push(rowTuple);
			}
		}

		const newTree = new BTree<BTreeKey, RowIdRow>(this.keyFromEntry, this.compareKeys);

		for (const rowTuple of rowsToUpdate) {
			const [rowid, dataArray] = rowTuple;
			const updatedDataArray = [...dataArray, defaultValue];
			newTree.insert([rowid, updatedDataArray]);
		}

		this.primaryTree = newTree;
		debugLog(`Added column '%s' to %d rows with default value %s`, columnName, rowsToUpdate.length, defaultValue);
	}

	/**
	 * Removes a column from all rows in the base layer tables.
	 * This should be called under a schema change lock.
	 *
	 * @param columnName Name of the column to remove
	 * @param columnIndexInSchema The index of the column in the *current* (pre-drop) table schema
	 * @returns true if the operation was successful
	 */
	dropColumnFromBase(columnName: string, columnIndexInSchema: number): boolean {
		const rowsToUpdate: RowIdRow[] = [];

		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const rowTuple = this.primaryTree.at(path);
			if (rowTuple) {
				rowsToUpdate.push(rowTuple);
			}
		}

		const newTree = new BTree<BTreeKey, RowIdRow>(this.keyFromEntry, this.compareKeys);

		for (const rowTuple of rowsToUpdate) {
			const [rowid, dataArray] = rowTuple;
			// Create a new data array without the specified column
			const newDataArray = dataArray.filter((_, idx) => idx !== columnIndexInSchema);
			newTree.insert([rowid, newDataArray]);
		}

		this.primaryTree = newTree;
		debugLog(`Removed column '%s' (at schema index %d) from %d rows`, columnName, columnIndexInSchema, rowsToUpdate.length);
		return true;
	}

	/**
	 * Renames a column in all rows in the base layer tables.
	 * For the tuple-based RowIdRow, this operation doesn't change the stored data itself,
	 * only the schema interpretation. The tree is rebuilt for consistency, but data arrays are identical.
	 * This should be called under a schema change lock.
	 *
	 * @param oldName Original name of the column
	 * @param newName New name for the column
	 * @returns true if the operation was successful
	 */
	renameColumnInBase(oldName: string, newName: string): boolean {
		const rowsToUpdate: RowIdRow[] = [];

		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const rowTuple = this.primaryTree.at(path);
			if (rowTuple) {
				rowsToUpdate.push(rowTuple);
			}
		}

		const newTree = new BTree<BTreeKey, RowIdRow>(this.keyFromEntry, this.compareKeys);

		for (const rowTuple of rowsToUpdate) {
			// Data itself doesn't change for a rename with tuple storage
			newTree.insert(rowTuple);
		}

		this.primaryTree = newTree;
		debugLog(`Renamed column '%s' to '%s'. Tree rebuilt, data arrays unchanged. %d rows processed.`, oldName, newName, rowsToUpdate.length);
		return true;
	}

	addIndexToBase(indexSchema: IndexSchema): void {
		if (this.secondaryIndexes.has(indexSchema.name)) {
			throw new Error(`Index '${indexSchema.name}' already exists in BaseLayer`);
		}
		const indexSpec: ConstructorParameters<typeof MemoryIndex>[0] = {
			name: indexSchema.name,
			columns: indexSchema.columns
		};
		const memoryIndex = new MemoryIndex(indexSpec, this.tableSchema.columns.map(c => ({ name: c.name })));
		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const rowTuple = this.primaryTree.at(path);
			if (rowTuple) {
				try { memoryIndex.addEntry(rowTuple); } catch (e) {
					errorLog(`Failed to add row to new index '%s': %O`, indexSchema.name, e);
				}
			}
		}
		this.secondaryIndexes.set(indexSchema.name, memoryIndex);
		debugLog(`Added and populated index '%s'`, indexSchema.name);
	}

	dropIndexFromBase(indexName: string): boolean {
		const index = this.secondaryIndexes.get(indexName);
		if (!index) {
			warnLog(`Attempted to drop non-existent index '%s'`, indexName);
			return false;
		}
		this.secondaryIndexes.delete(indexName);
		debugLog(`Dropped index '%s'`, indexName);
		return true;
	}

	has(key: BTreeKey): boolean {
		return this.primaryTree.get(key) !== undefined;
	}
}
