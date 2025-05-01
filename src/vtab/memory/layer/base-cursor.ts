import type { BTree, Path } from 'digitree';
import type { LayerCursorInternal } from './cursor.js';
import type { ScanPlan } from './scan-plan.js';
import type { BaseLayer } from './base.js';
import type { MemoryTableRow, BTreeKey } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import type { ModificationKey, ModificationValue } from './interface.js';
import { MemoryIndex } from '../index.js'; // Needed for secondary key comparison
import type { SqlValue } from '../../../common/types.js'; // Import SqlValue
import { createLogger } from '../../../common/logger.js'; // Import logger

const log = createLogger('vtab:memory:layer:base-cursor');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * Internal cursor implementation for iterating directly over a BaseLayer's B-trees.
 */
export class BaseLayerCursorInternal implements LayerCursorInternal {
	private readonly layer: BaseLayer;
	private readonly plan: ScanPlan;
	private readonly targetTree: BTree<any, any>; // BTree<BTreeKey, MemoryTableRow> or BTree<[BTreeKey, bigint], [BTreeKey, bigint]>
	private readonly keyComparator: (a: BTreeKey, b: BTreeKey) => number; // Index-specific comparator
	private readonly keyExtractor: (entry: any) => any; // Index-specific extractor

	private iterator: IterableIterator<Path<any, any>> | null = null;
	private currentPath: Path<any, any> | null = null;
	private _isEof: boolean = true;
	private currentValue: MemoryTableRow | null = null; // Holds the actual row data
	private currentModKey: ModificationKey | null = null; // Holds the index key ([IndexKey, rowid] or PrimaryKey)

	// Is this is the first advance after an EQ initialization
	private isInitialAdvanceAfterEqInit: boolean = false;

	constructor(layer: BaseLayer, plan: ScanPlan) {
		this.layer = layer;
		this.plan = plan;

		if (plan.indexName === 'primary') {
			this.targetTree = layer.primaryTree;
			// Get comparator from the BaseLayer instance
			this.keyComparator = layer.compareKeys;
			this.keyExtractor = layer.keyFromEntry;
		} else {
			const secondaryIndex = layer.secondaryIndexes.get(plan.indexName);
			if (!secondaryIndex) {
				throw new Error(`BaseLayerCursor: Secondary index '${plan.indexName}' not found.`);
			}
			this.targetTree = secondaryIndex.data;
			// Key for secondary index is [IndexKey, rowid]
			// Get comparator and extractor from the MemoryIndex instance
			// The comparator from MemoryIndex already compares the key part (BTreeKey)
			this.keyComparator = secondaryIndex.compareKeys;
			// The secondary BTree stores [key, rowid] as value, and its key is the pair itself.
			// We need the *index key* extractor from MemoryIndex for comparisons within checkPlan etc.
			this.keyExtractor = secondaryIndex.keyFromRow; // This extracts the IndexKey from a full MemoryTableRow
			// However, the BTree key itself is [IndexKey, rowid]. Let's keep the comparator as is for BTree ops.
		}

		this.initializeIterator();
	}

	// Helper to extract key and value at a specific path
	private extractKeyValueAt(path: Path<any, any>): { itemKey: ModificationKey | null, itemValue: MemoryTableRow | null } {
		let itemValue: MemoryTableRow | null = null;
		let itemKey: ModificationKey | null = null;

		if (this.plan.indexName === 'primary') {
			const rowValue = this.targetTree.at(path) as MemoryTableRow | null;
			if (rowValue) {
				itemValue = rowValue;
				try {
					itemKey = this.layer.keyFromEntry(itemValue);
				} catch (e) {
					warnLog("Failed to extract primary key from value at path: %O", e);
					// itemKey remains null
				}
			}
		} else {
			const secondaryEntry = this.targetTree.at(path) as [BTreeKey, bigint] | null;
			if (secondaryEntry) {
				itemKey = secondaryEntry; // Key is the [IndexKey, rowid] pair
				const rowid = secondaryEntry[1];
				const primaryKey = this.layer.rowidToKeyMap?.get(rowid);
				if (primaryKey !== undefined) {
					itemValue = this.layer.primaryTree.get(primaryKey) ?? null;
				} else if (!this.layer.rowidToKeyMap) {
					itemValue = this.layer.primaryTree.get(rowid) ?? null;
				} else {
					warnLog(`Could not find primary key for rowid %s from secondary index %s using rowidToKeyMap.`, rowid, this.plan.indexName);
					itemValue = null;
				}
			}
		}
		return { itemKey, itemValue };
	}

	private initializeIterator(): void {
		let startPath: Path<any, any> | null = null;
		const tree = this.targetTree;
		// Reset the flag
		this.isInitialAdvanceAfterEqInit = false;

		try {
			if (this.plan.equalityKey !== undefined) {
				// EQ Scan: Find the specific key.
				// For secondary index, the value stored (and thus the key extracted by BTree) is [IndexKey, rowid].
				// The plan.equalityKey needs to be formed correctly for the find operation.
				let findKey: ModificationKey;
				if (this.plan.indexName === 'primary') {
					findKey = this.plan.equalityKey;
				} else {
					// For secondary index, find needs the [IndexKey, rowid] pair.
					// We search for the *start* of potential matches for the IndexKey part.
					// Use a dummy minimal rowid (like 0) for the find.
					findKey = [this.plan.equalityKey, BigInt(0)];
				}
				// BTree's find uses its *own* key extractor and comparator internally, which operate on the stored value ([IndexKey, rowid] for secondary)
				startPath = tree.find(findKey);

				if (startPath) {
					// Check if the found path actually matches the equality key using checkPlan
					const { itemKey, itemValue } = this.extractKeyValueAt(startPath);

					if (itemKey !== null && this.checkPlan(itemKey)) {
						// Exact match found! Position cursor directly on it.
						this.currentPath = startPath;
						this.currentValue = itemValue;
						this.currentModKey = itemKey;
						this._isEof = false;
						// Initialize iterator for subsequent next() calls, starting *at* the current path
						this.iterator = this.plan.descending ? tree.descending(startPath) : tree.ascending(startPath);
						// Set the flag for the next advanceIterator call
						this.isInitialAdvanceAfterEqInit = true;
						// DO NOT advance iterator here, already positioned.
					} else {
						// find() landed somewhere else, or checkPlan failed. Key doesn't exist or value is null.
						this._isEof = true;
						this.iterator = null;
					}
				} else {
					// tree.find() returned null, key not found.
					this._isEof = true;
					this.iterator = null;
				}
			} else {
				// Full or Range Scan: Start from beginning or end.
				startPath = this.plan.descending ? tree.last() : tree.first();

				if (startPath) {
					this.iterator = this.plan.descending ? tree.descending(startPath) : tree.ascending(startPath);
					// Perform initial next() to position on the first valid element that matches bounds
					this.advanceIterator();
				} else {
					// Tree is empty
					this._isEof = true;
					this.iterator = null;
				}
			}
		} catch (e) {
			// Use namespaced error logger
			errorLog("Error initializing BTree iterator: %O", e);
			this._isEof = true;
			this.iterator = null;
			throw e; // Re-throw initialization errors
		}
	}

	private advanceIterator(): void {
		if (!this.iterator) {
			this._isEof = true;
			this.currentPath = null;
			this.currentValue = null;
			this.currentModKey = null;
			return;
		}

		// If this is the first advance after an EQ init, we need to call next() once
		// to move *past* the initial element the iterator might be sitting on.
		// Then proceed with the normal loop to find the *actual* next valid item.
		if (this.isInitialAdvanceAfterEqInit) {
			const initialResult = this.iterator.next(); // Consume the initial element
			this.isInitialAdvanceAfterEqInit = false; // Clear the flag
			if (initialResult.done) {
				this._isEof = true;
				this.currentPath = null;
				this.currentValue = null;
				this.currentModKey = null;
				return; // Nothing more to iterate
			}
		}

		let loopCount = 0;
		let foundNext = false;
		while (!foundNext) {
			loopCount++;
			const nextResult = this.iterator.next();

			if (nextResult.done) {
				this._isEof = true;
				this.currentPath = null;
				this.currentValue = null;
				this.currentModKey = null;
				break; // Exit loop, EOF reached
			}

			this.currentPath = nextResult.value;
			if (!this.currentPath) { // Should not happen if !done
				this._isEof = true;
				this.currentValue = null;
				this.currentModKey = null;
				break;
			}

			const { itemKey, itemValue } = this.extractKeyValueAt(this.currentPath);
			// Use replacer to handle BigInt in JSON.stringify
			const itemKeyStr = JSON.stringify(itemKey, (key, value) => typeof value === 'bigint' ? value.toString() + 'n' : value);

			if (itemKey === null) {
				continue; // Skip this entry
			}

			const planCheckResult = this.checkPlan(itemKey);
			// Use itemKeyStr for logging

			if (planCheckResult) {
				this.currentValue = itemValue; // itemValue guaranteed non-null if key wasn't null and checkPlan needs value potentially
				this.currentModKey = itemKey;
				this._isEof = false;
				foundNext = true; // Found a valid item, exit loop
			} else {
				// Plan check failed
				const stopCheckResult = this.shouldStopIteration(itemKey);
				// Use itemKeyStr for logging

				if (stopCheckResult) {
					this._isEof = true;
					this.currentPath = null;
					this.currentValue = null;
					this.currentModKey = null;
					break; // Exit loop, optimization
				} else {
					// Otherwise, continue to the next item in the iterator
				}
			}
		}
	}

	/** Checks if the extracted key satisfies the scan plan constraints */
	private checkPlan(key: ModificationKey): boolean {
		// Ensure plan's equality key exists before proceeding with EQ check
		if (this.plan.equalityKey === undefined) {
			// For Range/Full scan, check bounds if they exist.
			// Bounds usually apply to the first column of the index key.
			let firstColKey: SqlValue | null = null;
			if (this.plan.indexName === 'primary') {
				// Primary key (key is BTreeKey = SqlValue | SqlValue[])
				if (Array.isArray(key)) {
					// Ensure the first element is SqlValue, not another array (though unlikely for primary key)
					firstColKey = key.length > 0 && !Array.isArray(key[0]) ? key[0] : null;
				} else {
					firstColKey = key as SqlValue; // key is SqlValue here
				}
			} else {
				// Secondary key is [IndexKey, rowid]. IndexKey could be composite (BTreeKey = SqlValue | SqlValue[]).
				const indexKeyPart = (key as [BTreeKey, bigint])[0];
				if (Array.isArray(indexKeyPart)) {
					firstColKey = indexKeyPart.length > 0 && !Array.isArray(indexKeyPart[0]) ? indexKeyPart[0] : null;
				} else {
					firstColKey = indexKeyPart as SqlValue; // indexKeyPart is SqlValue here
				}
			}

			if (firstColKey === null && (this.plan.lowerBound || this.plan.upperBound)) {
				// If we couldn't extract a comparable first column key, but have bounds, assume it fails the check?
				// Or log a warning? Let's assume failure for safety.
				// Use namespaced warn logger
				warnLog("Could not extract first column key for range check.");
				return false;
			}

			if (this.plan.lowerBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.lowerBound.value);
				if (cmp < 0 || (cmp === 0 && this.plan.lowerBound.op === IndexConstraintOp.GT)) {
					return false; // Below lower bound
				}
			}
			if (this.plan.upperBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.upperBound.value);
				if (cmp > 0 || (cmp === 0 && this.plan.upperBound.op === IndexConstraintOp.LT)) {
					return false; // Above upper bound
				}
			}

			return true; // Passed checks or no bounds
		} else {
			// EQ scan: key must match exactly.
			// For secondary index, compare only the IndexKey part.
			// Extract the BTreeKey part for comparison
			const keyToCompare = this.plan.indexName === 'primary' ? (key as BTreeKey) : (key as [BTreeKey, bigint])[0];

			// Use the correct comparator based on index type
			// The `keyComparator` property is already set correctly in the constructor
			// to handle either primary or secondary key comparison.
			return this.keyComparator(keyToCompare, this.plan.equalityKey) === 0;
		}
	}

	/** Determines if iteration can stop early based on plan and current key */
	private shouldStopIteration(key: ModificationKey): boolean {
		// EQ scan should stop immediately if the key doesn't match (handled in checkPlan implicitly by BTree.find + iteration start)
		// More accurately, if the iterated key is *past* the equality key in the scan direction.
		if (this.plan.equalityKey !== undefined) {
			// Extract the BTreeKey part for comparison
			const keyToCompare = this.plan.indexName === 'primary' ? (key as BTreeKey) : (key as [BTreeKey, bigint])[0];

			// Use the correct comparator based on index type
			// The `keyComparator` property is already set correctly in the constructor.
			const cmp = this.keyComparator(keyToCompare, this.plan.equalityKey);

			if (this.plan.descending && cmp < 0) return true; // EQ DESC: gone past target
			if (!this.plan.descending && cmp > 0) return true; // EQ ASC: gone past target
			// If cmp === 0, we should continue if it's an EQ scan to check subsequent items
			// (though BTree iteration from find() often handles this correctly).
			// If it's a range scan, cmp===0 doesn't imply stopping.
		}

		// Check range bounds for early exit
		let firstColKey: SqlValue | null = null;
		if (this.plan.indexName === 'primary') {
			if (Array.isArray(key)) {
				firstColKey = key.length > 0 && !Array.isArray(key[0]) ? key[0] : null;
			} else {
				firstColKey = key as SqlValue;
			}
		} else {
			const indexKeyPart = (key as [BTreeKey, bigint])[0];
			if (Array.isArray(indexKeyPart)) {
				firstColKey = indexKeyPart.length > 0 && !Array.isArray(indexKeyPart[0]) ? indexKeyPart[0] : null;
			} else {
				firstColKey = indexKeyPart as SqlValue;
			}
		}

		if (firstColKey === null && (this.plan.lowerBound || this.plan.upperBound)) {
			// If bounds exist but we can't compare, we can't optimize, so don't stop early.
			return false;
		}

		if (!this.plan.descending) { // Ascending scan
			if (this.plan.upperBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.upperBound.value);
				// If current key is strictly greater than upper bound, stop.
				// If equal, only stop if bound op is LT.
				if (cmp > 0 || (cmp === 0 && this.plan.upperBound.op === IndexConstraintOp.LT)) {
					return true;
				}
			}
		} else { // Descending scan
			if (this.plan.lowerBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.lowerBound.value);
				// If current key is strictly less than lower bound, stop.
				// If equal, only stop if bound op is GT.
				if (cmp < 0 || (cmp === 0 && this.plan.lowerBound.op === IndexConstraintOp.GT)) {
					return true;
				}
			}
		}
		return false;
	}

	async next(): Promise<void> {
		if (!this._isEof) {
			this.advanceIterator();
		}
	}

	getCurrentRow(): MemoryTableRow | null {
		return this._isEof ? null : this.currentValue;
	}

	getCurrentModificationKey(): ModificationKey | null {
		return this._isEof ? null : this.currentModKey;
	}

	getCurrentLayerValue(): ModificationValue | null {
		// BaseLayerCursor always represents a full row, not a modification marker
		return this._isEof ? null : this.currentValue;
	}

	isEof(): boolean {
		return this._isEof;
	}

	close(): void {
		// No specific resources to close for base iterator, BTree handles its state.
		this.iterator = null;
		this.currentPath = null;
		this.currentValue = null;
		this.currentModKey = null;
		this._isEof = true;
	}
}
