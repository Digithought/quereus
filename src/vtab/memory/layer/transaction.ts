import { BTree } from 'digitree';
import type { TableSchema } from '../../../schema/table.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { MemoryIndex } from '../index.js';
import type { SqlValue, Row } from '../../../common/types.js';
import { isDeletionMarker, DELETED, type BTreeKeyForPrimary, type BTreeKeyForIndex, type DeletionMarker, type PrimaryModificationValue } from '../types.js';
import type { Layer } from './interface.js';

let transactionLayerCounter = 0;

/**
 * Represents a set of modifications (inserts, updates, deletes) applied
 * on top of a parent Layer (either BaseLayer or another TransactionLayer).
 * These layers are immutable once created for a transaction. Commit marks
 * them as eligible for merging.
 */
export class TransactionLayer implements Layer {
	private readonly layerId: number;
	public readonly parentLayer: Layer;
	private readonly tableSchemaAtCreation: TableSchema; // Schema when this layer was started
	private modifications: Map<string | 'primary', BTree<BTreeKeyForPrimary, PrimaryModificationValue>>;
	private affectedKeysForSecondaryIndexUpdate: Map<string, Map<string, {op: 'ADD' | 'DELETE', pk: BTreeKeyForPrimary, indexKey: BTreeKeyForIndex}>>;
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
		this.modifications = new Map();
		this.affectedKeysForSecondaryIndexUpdate = new Map();
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
			Object.freeze(this.affectedKeysForSecondaryIndexUpdate);
		}
	}

	// This layer determines PK functions based on the schema it was created with.
	public getPkExtractorsAndComparators(schema: TableSchema): {
		primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number
	} {
		if (schema !== this.tableSchemaAtCreation) {
			console.warn("TransactionLayer.getPkExtractorsAndComparators called with a schema different from its creation schema. Using creation schema.");
		}
		// Use a local or cached version of createBaseLayerPkFunctions or equivalent logic
		// based on this.tableSchemaAtCreation.
		// For simplicity, let's assume direct computation or a simple cache here.
		const cacheKey = 'primary_extract_compare_tx'; // Ensure different cache key or handle properly
		// This caching logic might need to be on this.btreeFuncsCacheForKeyExtraction
		// if (this.btreeFuncsCacheForKeyExtraction.has(cacheKey)) {
		//   return this.btreeFuncsCacheForKeyExtraction.get(cacheKey)!;
		// }

		const pkDef = this.tableSchemaAtCreation.primaryKeyDefinition ?? [];
		if (pkDef.length === 0) throw new Error("TransactionLayer: Table schema must have a primaryKeyDefinition.");

		const primaryKeyExtractorFromRow = (row: Row): BTreeKeyForPrimary =>
			pkDef.length === 1 ? row[pkDef[0].index] : pkDef.map(d => row[d.index]);

		const primaryKeyComparator = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
			if (pkDef.length === 1) {
				const def = pkDef[0];
				const cmp = compareSqlValues(a as SqlValue, b as SqlValue, def.collation || 'BINARY');
				return def.desc ? -cmp : cmp;
			}
			const arrA = a as SqlValue[]; const arrB = b as SqlValue[];
			for (let i = 0; i < pkDef.length; i++) {
				if (i >= arrA.length || i >= arrB.length) return arrA.length - arrB.length;
				const def = pkDef[i];
				const cmp = compareSqlValues(arrA[i], arrB[i], def.collation || 'BINARY');
				if (cmp !== 0) return def.desc ? -cmp : cmp;
			}
			return 0;
		};
		const result = { primaryKeyExtractorFromRow, primaryKeyComparator };
		// this.btreeFuncsCacheForKeyExtraction.set(cacheKey, result); // Cache if needed
		return result;
	}

	private getOrCreatePrimaryModificationTree(): BTree<BTreeKeyForPrimary, PrimaryModificationValue> {
		let tree = this.modifications.get('primary');
		if (!tree) {
			const { primaryKeyExtractorFromRow, primaryKeyComparator } = this.getPkExtractorsAndComparators(this.tableSchemaAtCreation);
			const btreeKeyFromValue = (value: PrimaryModificationValue): BTreeKeyForPrimary =>
				isDeletionMarker(value) ? value._key_ : primaryKeyExtractorFromRow(value as Row);
			tree = new BTree(btreeKeyFromValue, primaryKeyComparator);
			this.modifications.set('primary', tree);
		}
		return tree;
	}

	getModificationTree(indexName: string | 'primary'): BTree<BTreeKeyForPrimary, PrimaryModificationValue> | null {
		if (indexName === 'primary') return this.modifications.get('primary') ?? null;
		return null; // Secondary index changes are tracked in affectedKeysForSecondaryIndexUpdate
	}

	getSecondaryIndexTree(_indexName: string): null { return null; }

	/** Records an insert or update in this transaction layer */
	recordUpsert(primaryKey: BTreeKeyForPrimary, newRowData: Row, oldRowDataIfUpdate?: Row | null): void {
		if (this._isCommitted) throw new Error("Cannot modify a committed layer");
		const primaryTree = this.getOrCreatePrimaryModificationTree();
		primaryTree.insert(newRowData);

		const schema = this.getSchema();
		schema.indexes?.forEach(indexSchema => {
			const indexName = indexSchema.name;
			const tempIndex = new MemoryIndex({ name: indexName, columns: indexSchema.columns }, schema.columns);
			let indexSpecificChanges = this.affectedKeysForSecondaryIndexUpdate.get(indexName);
			if (!indexSpecificChanges) {
				indexSpecificChanges = new Map();
				this.affectedKeysForSecondaryIndexUpdate.set(indexName, indexSpecificChanges);
			}
			const serializedPK = JSON.stringify(primaryKey); // Simple serialization for PK as map key

			if (oldRowDataIfUpdate) { // UPDATE
				const oldIndexKey = tempIndex.keyFromRow(oldRowDataIfUpdate);
				const newIndexKey = tempIndex.keyFromRow(newRowData);
				if (tempIndex.compareKeys(oldIndexKey, newIndexKey) !== 0) {
					indexSpecificChanges.set(`DELETE_${serializedPK}_${JSON.stringify(oldIndexKey)}`, {op: 'DELETE', pk: primaryKey, indexKey: oldIndexKey});
					indexSpecificChanges.set(`ADD_${serializedPK}_${JSON.stringify(newIndexKey)}`, {op: 'ADD', pk: primaryKey, indexKey: newIndexKey});
				} else {
					// Index key is same, but row data changed, so it's effectively an update for this index entry
					// For simplicity in BaseLayer collapse, we can treat as DEL old PK + ADD new PK for this index key
					// or just mark for ADD, assuming BaseLayer handles overwrite if it's a unique index.
					// Simpler: if data changed at all, it's an ADD for the (unchanged) index key.
					indexSpecificChanges.set(`ADD_${serializedPK}_${JSON.stringify(newIndexKey)}`, {op: 'ADD', pk: primaryKey, indexKey: newIndexKey});
				}
			} else { // INSERT
				const newIndexKey = tempIndex.keyFromRow(newRowData);
				indexSpecificChanges.set(`ADD_${serializedPK}_${JSON.stringify(newIndexKey)}`, {op: 'ADD', pk: primaryKey, indexKey: newIndexKey});
			}
		});
	}

	/** Records a delete in this transaction layer */
	recordDelete(primaryKey: BTreeKeyForPrimary, oldRowDataForIndexes: Row): void {
		if (this._isCommitted) throw new Error("Cannot modify a committed layer");
		const primaryTree = this.getOrCreatePrimaryModificationTree();
		const deletionMarker: DeletionMarker = { _marker_: DELETED, _key_: primaryKey };
		primaryTree.insert(deletionMarker);

		const schema = this.getSchema();
		schema.indexes?.forEach(indexSchema => {
			const indexName = indexSchema.name;
			const tempIndex = new MemoryIndex({ name: indexName, columns: indexSchema.columns }, schema.columns);
			const oldIndexKey = tempIndex.keyFromRow(oldRowDataForIndexes);
			let indexSpecificChanges = this.affectedKeysForSecondaryIndexUpdate.get(indexName);
			if (!indexSpecificChanges) {
				indexSpecificChanges = new Map();
				this.affectedKeysForSecondaryIndexUpdate.set(indexName, indexSpecificChanges);
			}
			indexSpecificChanges.set(`DELETE_${JSON.stringify(primaryKey)}_${JSON.stringify(oldIndexKey)}`, {op: 'DELETE', pk: primaryKey, indexKey: oldIndexKey});
		});
	}

	// Method to retrieve index changes for collapsing into BaseLayer
	public getSecondaryIndexChanges(): Map<string, Map<string, {op: 'ADD' | 'DELETE', pk: BTreeKeyForPrimary, indexKey: BTreeKeyForIndex}>> {
		return this.affectedKeysForSecondaryIndexUpdate;
	}

	public hasChanges(): boolean {
		if (this.modifications.get('primary')?.getCount() ?? 0 > 0) {
			return true;
		}
		for (const [_indexName, pkMap] of this.affectedKeysForSecondaryIndexUpdate) {
			if (pkMap.size > 0) return true;
		}
		return false;
	}
}
