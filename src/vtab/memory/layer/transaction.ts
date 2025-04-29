import { BTree } from 'digitree';
import type { TableSchema, IndexSchema } from '../../../schema/table.js';
import type { MemoryTableRow, BTreeKey, ModificationKey, ModificationValue, DeletionMarker } from '../types.js';
import { compareSqlValues } from '../../../util/comparison.js'; // Corrected path
import { MemoryIndex } from '../index.js'; // Needed for key extraction/comparison logic
import type { SqlValue } from '../../../common/types.js'; // Corrected path
import { isDeletionMarker, DELETED } from '../types.js'; // Import from types.ts
import type { Layer } from './interface.js'; // Corrected path

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
			const columns = schema.columns.map(c => ({ name: c.name }));

			if (pkDef.length === 0) { // Rowid key
				const keyExtractor = (value: ModificationValue): ModificationKey =>
					isDeletionMarker(value) ? value._key_ as bigint : value._rowid_; // Check marker
				const comparator = (a: ModificationKey, b: ModificationKey): number =>
					compareSqlValues(a as bigint, b as bigint);
				funcs = { keyExtractor, comparator };
			} else if (pkDef.length === 1) { // Single column PK
				const { index: pkIndex, desc: isDesc } = pkDef[0];
				const pkColName = columns[pkIndex]?.name;
				const pkCollation = schema.columns[pkIndex]?.collation ?? 'BINARY';
				if (!pkColName) throw new Error("Invalid PK schema in TransactionLayer");
				const keyExtractor = (value: ModificationValue): ModificationKey =>
					isDeletionMarker(value) ? value._key_ as BTreeKey : value[pkColName] as BTreeKey; // Check marker
				const comparator = (a: ModificationKey, b: ModificationKey): number => {
					const cmp = compareSqlValues(a as SqlValue, b as SqlValue, pkCollation);
					return isDesc ? -cmp : cmp;
				};
				funcs = { keyExtractor, comparator };
			} else { // Composite PK
				const pkCols = pkDef.map(def => ({
					name: columns[def.index]?.name,
					desc: def.desc,
					collation: schema.columns[def.index]?.collation || 'BINARY'
				}));
				if (pkCols.some(c => !c.name)) throw new Error("Invalid composite PK schema in TransactionLayer");
				const pkColNames = pkCols.map(c => c.name!);
				const keyExtractor = (value: ModificationValue): ModificationKey =>
					isDeletionMarker(value) ? value._key_ as SqlValue[] : pkColNames.map(name => value[name]); // Check marker
				const comparator = (a: ModificationKey, b: ModificationKey): number => {
					const arrA = a as SqlValue[]; const arrB = b as SqlValue[];
					const len = Math.min(arrA.length, arrB.length);
					for (let i = 0; i < len; i++) {
						const dirMultiplier = pkCols[i].desc ? -1 : 1;
						const collation = pkCols[i].collation;
						const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
						if (cmp !== 0) return cmp;
					}
					return arrA.length - arrB.length;
				};
				funcs = { keyExtractor, comparator };
			}
		} else {
			// Secondary Index: Key is [IndexKey, rowid]
			const indexSchema = schema.indexes?.find(idx => idx.name === indexName);
			if (!indexSchema) throw new Error(`Secondary index ${indexName} not found in schema for TransactionLayer`);

			const tempIndex = new MemoryIndex({ name: indexSchema.name, columns: indexSchema.columns }, schema.columns.map(c => ({ name: c.name })));

			// Key for the modification BTree is [IndexKey, rowid]
			const keyExtractor = (value: ModificationValue): ModificationKey => {
				if (isDeletionMarker(value)) {
					return value._key_ as [BTreeKey, bigint]; // Deletion marker stores the composite key
				} else {
					const indexKey = tempIndex.keyFromRow(value);
					const rowid = value._rowid_;
					return [indexKey, rowid];
				}
			};
			// Comparator for [IndexKey, rowid] pairs
			const comparator = (a: ModificationKey, b: ModificationKey): number => {
				const [keyA, rowidA] = a as [BTreeKey, bigint];
				const [keyB, rowidB] = b as [BTreeKey, bigint];
				const keyCmp = tempIndex.compareKeys(keyA, keyB);
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
		// Retrieve or create the tree to ensure its comparator is initialized
		const tree = this.getOrCreateModificationTree(indexName);
		// The BTree's comparator operates on the *entry type* (ModificationValue).
		// We need to return a comparator that works on the *key type* (ModificationKey).
		// We can leverage the getBTreeFuncs helper which already defines the key comparator.
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
		// Retrieve or create the tree to ensure its extractor is initialized
		const tree = this.getOrCreateModificationTree(indexName);
		// Similar to comparator, leverage getBTreeFuncs.
		return this.getBTreeFuncs(indexName).keyExtractor;
	}

	getModificationTree(indexName: string | 'primary'): BTree<ModificationKey, ModificationValue> | null {
		return this.modifications.get(indexName) ?? null;
	}

	getSecondaryIndexTree(indexName: string): BTree<[BTreeKey, bigint], [BTreeKey, bigint]> | null {
		// Transaction layers store modifications, not full index trees. Cursors handle merging.
		return null; // Return null as this layer doesn't hold the full index data
	}

	getDeletedRowids(): ReadonlySet<bigint> {
		return this.deletedRowidsInLayer;
	}

	/** Records an insert or update in this transaction layer */
	recordUpsert(row: MemoryTableRow, affectedIndexes: ReadonlyArray<string | 'primary'>): void {
		if (this._isCommitted) throw new Error("Cannot modify a committed layer");

		// If this row was previously deleted in *this* layer, remove the delete marker.
		this.deletedRowidsInLayer.delete(row._rowid_);

		for (const indexName of affectedIndexes) {
			const tree = this.getOrCreateModificationTree(indexName);
			// BTree.insert takes the value; the key is extracted by the tree's keyExtractor
			tree.insert(row);
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
