import { BTree } from 'digitree';
import type { TableSchema } from '../../../schema/table.js';
import type { MemoryTableRow, BTreeKey, ModificationKey, ModificationValue, DeletionMarker } from '../types.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { MemoryIndex } from '../index.js';
import type { SqlValue } from '../../../common/types.js';
import { isDeletionMarker, DELETED } from '../types.js';
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
	// Stores modifications keyed by index-specific keys.
	// 'primary' maps primary keys -> MemoryTableRow | DELETED
	// indexName maps [indexKey, rowid] -> MemoryTableRow | DELETED (value needed for filtering?)
	// Alternatively, secondary mods could just store rowids? Let's start with MemoryTableRow | DELETED for simplicity.
	private modifications: Map<string | 'primary', BTree<ModificationKey, ModificationValue>>;
	private deletedRowidsInLayer: Set<bigint>; // Rowids explicitly deleted *in this layer*
	private _isCommitted: boolean = false;

	// Cache for BTree funcs to avoid recalculation
	private btreeFuncsCache: Map<string | 'primary', { keyExtractor: (value: ModificationValue) => ModificationKey; comparator: (a: ModificationKey, b: ModificationKey) => number; }> = new Map();

	constructor(parent: Layer) {
		this.layerId = transactionLayerCounter++;
		this.parentLayer = parent;
		this.tableSchemaAtCreation = parent.getSchema(); // Inherit schema from parent at creation
		this.modifications = new Map();
		this.deletedRowidsInLayer = new Set();
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
			// Freezing removed as digitree might not support it
			// this.modifications.forEach(tree => tree.freeze?.());
			Object.freeze(this.deletedRowidsInLayer); // Keep freezing the set
		}
	}

	/** Gets or creates the modification BTree for a given index */
	private getOrCreateModificationTree(indexName: string | 'primary'): BTree<ModificationKey, ModificationValue> {
		let tree = this.modifications.get(indexName);
		if (!tree) {
			const { keyExtractor, comparator } = this.getBTreeFuncs(indexName);
			tree = new BTree<ModificationKey, ModificationValue>(keyExtractor, comparator);
			this.modifications.set(indexName, tree);
		}
		return tree;
	}

	/** Returns the BTree functions (key extractor, comparator) for a given index name */
	public getBTreeFuncs(indexName: string | 'primary'): {
		keyExtractor: (value: ModificationValue) => ModificationKey;
		comparator: (a: ModificationKey, b: ModificationKey) => number;
	} {
		// Check cache first
		const cachedFuncs = this.btreeFuncsCache.get(indexName);
		if (cachedFuncs) {
			return cachedFuncs;
		}

		const schema = this.getSchema();
		let funcs: {
			keyExtractor: (value: ModificationValue) => ModificationKey;
			comparator: (a: ModificationKey, b: ModificationKey) => number;
		};

		if (indexName === 'primary') {
			const pkDef = schema.primaryKeyDefinition ?? [];

			if (pkDef.length === 0) { // Rowid key
				const keyExtractor = (value: ModificationValue): ModificationKey =>
					isDeletionMarker(value) ? value._key_ as bigint : (value as MemoryTableRow)[0]; // rowid from tuple
				const comparator = (a: ModificationKey, b: ModificationKey): number =>
					compareSqlValues(a as bigint, b as bigint);
				funcs = { keyExtractor, comparator };
			} else if (pkDef.length === 1) { // Single column PK
				const { index: pkSchemaIndex, desc: isDesc, collation } = pkDef[0];
				const keyExtractor = (value: ModificationValue): ModificationKey =>
					isDeletionMarker(value) ? value._key_ as BTreeKey : (value as MemoryTableRow)[1][pkSchemaIndex] as BTreeKey;
				const comparator = (a: ModificationKey, b: ModificationKey): number => {
					const cmp = compareSqlValues(a as SqlValue, b as SqlValue, collation || 'BINARY');
					return isDesc ? -cmp : cmp;
				};
				funcs = { keyExtractor, comparator };
			} else { // Composite PK
				const pkColSchemaIndices = pkDef.map(def => def.index);
				const keyExtractor = (value: ModificationValue): ModificationKey =>
					isDeletionMarker(value) ? value._key_ as SqlValue[] : pkColSchemaIndices.map(i => (value as MemoryTableRow)[1][i]);
				const comparator = (a: ModificationKey, b: ModificationKey): number => {
					const arrA = a as SqlValue[]; const arrB = b as SqlValue[];
					const len = Math.min(arrA.length, arrB.length, pkDef.length);
					for (let i = 0; i < len; i++) {
						const def = pkDef[i];
						const dirMultiplier = def.desc ? -1 : 1;
						const collation = def.collation || 'BINARY';
						const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
						if (cmp !== 0) return cmp;
					}
					return arrA.length - arrB.length;
				};
				funcs = { keyExtractor, comparator };
			}
		} else {
			// Secondary Index: Key for modification BTree is [IndexKey, rowid]
			const indexSchema = schema.indexes?.find(idx => idx.name === indexName);
			if (!indexSchema) throw new Error(`Secondary index ${indexName} not found in schema for TransactionLayer`);

			// Create a temporary MemoryIndex to leverage its keyFromRow and compareKeys logic for the *IndexKey* part.
			// MemoryIndex constructor expects allTableColumns as {name: string}[], but it only uses it for validation if spec has names.
			// Here, our indexSchema.columns already have schema indices.
			// We pass a dummy name array, as MemoryIndex.keyFromRow (new version) uses specColumn.index directly.
			const dummyTableCols = schema.columns.map(c => ({ name: c.name }));
			const tempIndex = new MemoryIndex({ name: indexSchema.name, columns: indexSchema.columns }, dummyTableCols);

			const keyExtractor = (value: ModificationValue): ModificationKey => {
				if (isDeletionMarker(value)) {
					return value._key_ as [BTreeKey, bigint]; // Deletion marker stores the composite [IndexKey, rowid]
				} else {
					const rowTuple = value as MemoryTableRow;
					const indexKeyPart = tempIndex.keyFromRow(rowTuple); // Extracts IndexKey from tuple data array
					const rowid = rowTuple[0]; // rowid from tuple
					return [indexKeyPart, rowid];
				}
			};
			const comparator = (a: ModificationKey, b: ModificationKey): number => {
				const [keyA, rowidA] = a as [BTreeKey, bigint];
				const [keyB, rowidB] = b as [BTreeKey, bigint];
				const keyCmp = tempIndex.compareKeys(keyA, keyB); // Compares IndexKey part
				if (keyCmp !== 0) return keyCmp;
				return compareSqlValues(rowidA, rowidB);
			};
			funcs = { keyExtractor, comparator };
		}

		// Store in cache and return
		this.btreeFuncsCache.set(indexName, funcs);
		return funcs;
	}

	/** Gets the appropriate key comparator for the modification tree of a given index */
	public getComparator(indexName: string | 'primary'): (a: ModificationKey, b: ModificationKey) => number {
		// this.getOrCreateModificationTree(indexName); // Ensures tree exists, but result not needed here
		return this.getBTreeFuncs(indexName).comparator;
	}

	/**
	 * Gets the key comparator for a specific index.
	 * This is needed for the TransactionLayerCursorInternal.
	 */
	public getKeyComparator(indexName: string | 'primary'): (a: BTreeKey, b: BTreeKey) => number {
		// This wraps the modKey comparator to work with BTreeKey inputs
		const modComparator = this.getComparator(indexName);

		if (indexName === 'primary') {
			// For primary, ModificationKey is BTreeKey directly
			return modComparator as (a: BTreeKey, b: BTreeKey) => number;
		} else {
			// For secondary, we need to extract the first part of the ModificationKey
			// and compare only that part
			return (a: BTreeKey, b: BTreeKey): number => {
				// Create dummy ModificationKeys from BTreeKeys for comparison
				// The comparator should only look at the key part anyway
				const dummyA: [BTreeKey, bigint] = [a, BigInt(0)];
				const dummyB: [BTreeKey, bigint] = [b, BigInt(0)];
				return modComparator(dummyA, dummyB);
			};
		}
	}

	/** Gets the appropriate key extractor for the modification tree of a given index */
	public getKeyExtractor(indexName: string | 'primary'): (value: ModificationValue) => ModificationKey {
		// this.getOrCreateModificationTree(indexName); // Ensures tree exists, but result not needed here
		return this.getBTreeFuncs(indexName).keyExtractor;
	}

	getModificationTree(indexName: string | 'primary'): BTree<ModificationKey, ModificationValue> | null {
		return this.modifications.get(indexName) ?? null;
	}

	getSecondaryIndexTree(_indexName: string): BTree<[BTreeKey, bigint], [BTreeKey, bigint]> | null {
		// Transaction layers store modifications, not full index trees. Cursors handle merging.
		return null; // Return null as this layer doesn't hold the full index data
	}

	getDeletedRowids(): ReadonlySet<bigint> {
		return this.deletedRowidsInLayer;
	}

	/** Records an insert or update in this transaction layer */
	recordUpsert(newRowTuple: MemoryTableRow, affectedIndexes: ReadonlyArray<string | 'primary'>, _oldRowTuple?: MemoryTableRow | null): void {
		if (this._isCommitted) throw new Error("Cannot modify a committed layer");
		const rowid = newRowTuple[0];

		// If an old row tuple is provided (for an update), we might need to remove its old secondary index entries.
		// This is complex because the ModificationValue stored in secondary index B-trees is the newRowTuple (or deletion marker).
		// For simplicity, the current MemoryTableManager.applyChange handles old/new secondary index updates during collapse.
		// So, here we just focus on adding/overwriting the new state.

		this.deletedRowidsInLayer.delete(rowid);

		for (const indexName of affectedIndexes) {
			const tree = this.getOrCreateModificationTree(indexName);
			// For primary index, key is PK. For secondary, key is [IndexKey, rowid].
			// The BTree uses its keyExtractor on newRowTuple to get the key for insertion.
			tree.insert(newRowTuple); // Store the new tuple directly
		}
	}

	/** Records a delete in this transaction layer */
	recordDelete(rowid: bigint, primaryKey: BTreeKey, indexKeys: Map<string, [BTreeKey, bigint]>): void {
		if (this._isCommitted) throw new Error("Cannot modify a committed layer");

		this.deletedRowidsInLayer.add(rowid);

		// Create and store deletion marker for the primary index
		const primaryTree = this.getOrCreateModificationTree('primary');
		const primaryDeletionMarker: DeletionMarker = { _marker_: DELETED, _key_: primaryKey, _rowid_: rowid };
		primaryTree.insert(primaryDeletionMarker);

		// Create and store deletion markers for relevant secondary indexes
		for (const [indexName, indexModKey] of indexKeys.entries()) {
			const secondaryTree = this.getOrCreateModificationTree(indexName);
			const secondaryDeletionMarker: DeletionMarker = { _marker_: DELETED, _key_: indexModKey, _rowid_: rowid };
			secondaryTree.insert(secondaryDeletionMarker);
		}
	}
}
