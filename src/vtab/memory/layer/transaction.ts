import { BTree } from 'inheritree';
import type { TableSchema } from '../../../schema/table.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { MemoryIndex } from '../index.js';
import type { SqlValue, Row } from '../../../common/types.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import type { Layer } from './interface.js';
import { createLogger } from '../../../common/logger.js';
import { createPrimaryKeyFunctions } from '../utils/primary-key.js';

const log = createLogger('vtab:memory:layer:transaction');
const warnLog = log.extend('warn');

let transactionLayerCounter = 1000;

/**
 * Represents a set of modifications (inserts, updates, deletes) applied
 * on top of a parent Layer using inherited BTrees with copy-on-write semantics.
 * These layers are immutable once committed.
 */
export class TransactionLayer implements Layer {
	private readonly layerId: number;
	public readonly parentLayer: Layer;
	private readonly tableSchemaAtCreation: TableSchema; // Schema when this layer was started

	// Primary modifications BTree that inherits from parent
	private primaryModifications: BTree<BTreeKeyForPrimary, Row>;

	// Secondary index BTrees that inherit from parent's indexes
	private secondaryIndexes: Map<string, MemoryIndex>;

	private _isCommitted: boolean = false;

	// Cache for BTree funcs to avoid recalculation
	private btreeFuncsCacheForKeyExtraction: Map<string | 'primary', {
		primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
		indexKeyExtractorFromRow?: (row: Row) => BTreeKeyForIndex;
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;
		indexKeyComparator?: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
	}> = new Map();

	constructor(parent: Layer) {
		this.layerId = transactionLayerCounter++;
		this.parentLayer = parent;
		this.tableSchemaAtCreation = parent.getSchema(); // Schema is fixed at creation

		// Initialize primary modifications BTree with parent's primary tree as base
		const { primaryKeyExtractorFromRow, primaryKeyComparator } = this.getPkExtractorsAndComparators(this.tableSchemaAtCreation);
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary => {
			const result = primaryKeyExtractorFromRow(value);
			return result;
		};

		const parentPrimaryTree = parent.getModificationTree('primary');

		this.primaryModifications = new BTree(
			btreeKeyFromValue,
			primaryKeyComparator,
			parentPrimaryTree || undefined // Use parent's primary tree as base
		);

		// Initialize secondary indexes that inherit from parent's secondary indexes
		this.secondaryIndexes = new Map();
		this.initializeSecondaryIndexes();
	}

	private initializeSecondaryIndexes(): void {
		const schema = this.tableSchemaAtCreation;
		if (!schema.indexes) return;

		for (const indexSchema of schema.indexes) {
			const parentSecondaryTree = this.parentLayer.getSecondaryIndexTree?.(indexSchema.name);
			// Create MemoryIndex with inherited BTree
			const memoryIndex = new MemoryIndex(
				indexSchema,
				schema.columns,
				parentSecondaryTree || undefined // Use parent's secondary index tree as base
			);
			this.secondaryIndexes.set(indexSchema.name, memoryIndex);
		}
	}

	getLayerId(): number {
		return this.layerId;
	}

	getParent(): Layer {
		return this.parentLayer;
	}

	getSchema(): TableSchema {
		// Return the schema as it was when this transaction started
		return this.tableSchemaAtCreation;
	}

	isCommitted(): boolean {
		return this._isCommitted;
	}

	/** Marks this layer as committed. Should only be done by MemoryTable. */
	markCommitted(): void {
		if (!this._isCommitted) {
			this._isCommitted = true;
			// With inherited BTrees, we don't need to freeze complex change tracking structures
		}
	}

	public getPkExtractorsAndComparators(schema: TableSchema): {
		primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number
	} {
		if (schema !== this.tableSchemaAtCreation) {
			warnLog("TransactionLayer.getPkExtractorsAndComparators called with a schema different from its creation schema. Using creation schema.");
		}

		// Use the centralized primary key functions instead of duplicating the logic
		// This ensures consistent handling of empty primary key definitions
		const pkFunctions = createPrimaryKeyFunctions(this.tableSchemaAtCreation);
		return {
			primaryKeyExtractorFromRow: pkFunctions.extractFromRow,
			primaryKeyComparator: pkFunctions.compare
		};
	}

	getModificationTree(indexName: string | 'primary'): BTree<BTreeKeyForPrimary, Row> | null {
		if (indexName === 'primary') return this.primaryModifications;
		return null; // Secondary indexes are accessed via getSecondaryIndexTree
	}

	getSecondaryIndexTree(indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null {
		return this.secondaryIndexes.get(indexName)?.data ?? null;
	}

	/** Records an insert or update in this transaction layer */
	recordUpsert(primaryKey: BTreeKeyForPrimary, newRowData: Row, oldRowDataIfUpdate?: Row | null): void {
		if (this._isCommitted) throw new Error("Cannot modify a committed layer");

		this.primaryModifications.upsert(newRowData);

		// Update secondary indexes
		const schema = this.getSchema();
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				const memoryIndex = this.secondaryIndexes.get(indexSchema.name);
				if (!memoryIndex) continue;

				if (oldRowDataIfUpdate) { // UPDATE
					const oldIndexKey = memoryIndex.keyFromRow(oldRowDataIfUpdate);
					const newIndexKey = memoryIndex.keyFromRow(newRowData);

					// If index key changed, remove old and add new
					if (memoryIndex.compareKeys(oldIndexKey, newIndexKey) !== 0) {
						memoryIndex.removeEntry(oldIndexKey, primaryKey);
						memoryIndex.addEntry(newIndexKey, primaryKey);
					} else {
						// Index key is same, but we might need to update the entry
						// With inherited BTrees, the existing entry will be copied on write
						memoryIndex.addEntry(newIndexKey, primaryKey);
					}
				} else { // INSERT
					const newIndexKey = memoryIndex.keyFromRow(newRowData);
					memoryIndex.addEntry(newIndexKey, primaryKey);
				}
			}
		}
	}

	/** Records a delete in this transaction layer */
	recordDelete(primaryKey: BTreeKeyForPrimary, oldRowDataForIndexes: Row): void {
		if (this._isCommitted) throw new Error("Cannot modify a committed layer");

		// Find the existing entry
		const existingPath = this.primaryModifications.find(primaryKey);
		if (existingPath.on) {
			// Entry exists (locally or inherited) - use deleteAt to remove it
			this.primaryModifications.deleteAt(existingPath);
		}
		// If key doesn't exist, there's nothing to delete - no deletion marker needed
		// Inheritree's copy-on-write semantics handle this properly

		// Update secondary indexes to remove entries
		const schema = this.getSchema();
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				const memoryIndex = this.secondaryIndexes.get(indexSchema.name);
				if (!memoryIndex) continue;

				const oldIndexKey = memoryIndex.keyFromRow(oldRowDataForIndexes);
				memoryIndex.removeEntry(oldIndexKey, primaryKey);
			}
		}
	}

	public hasChanges(): boolean {
		// Check if primary modifications BTree has any entries beyond its base
		if (this.primaryModifications.getCount() > 0) {
			// Note: getCount() might include inherited entries, so we need a better way
			// to check if this layer has modifications. This depends on inheritree's API.
			// For now, assume any count > 0 means changes (might need refinement)
			return true;
		}

		// Check secondary indexes for changes
		for (const memoryIndex of this.secondaryIndexes.values()) {
			if (memoryIndex.size > 0) {
				// Same caveat as above - this might include inherited entries
				return true;
			}
		}

		return false;
	}

	/**
	 * Detaches this layer's BTrees from their base, making them self-contained.
	 * This should be called when the layer becomes the new effective base.
	 */
	public clearBase(): void {
		// Clear base for primary modifications
		if (typeof (this.primaryModifications as any).clearBase === 'function') {
			(this.primaryModifications as any).clearBase();
		}

		// Clear base for secondary indexes
		for (const memoryIndex of this.secondaryIndexes.values()) {
			memoryIndex.clearBase();
		}
	}
}
