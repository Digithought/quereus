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
const debugLog = log.extend('debug');

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

	// Flag specifically for EQ plan handling
	private isEqPlanCursor: boolean = false;

	constructor(layer: BaseLayer, plan: ScanPlan) {
		this.layer = layer;
		this.plan = plan;
		this.isEqPlanCursor = plan.equalityKey !== undefined;

		if (plan.indexName === 'primary') {
			this.targetTree = layer.primaryTree;
			this.keyComparator = layer.compareKeys;
			this.keyExtractor = layer.keyFromEntry;
		} else {
			const secondaryIndex = layer.secondaryIndexes.get(plan.indexName);
			if (!secondaryIndex) {
				throw new Error(`BaseLayerCursor: Secondary index '${plan.indexName}' not found.`);
			}
			this.targetTree = secondaryIndex.data;
			this.keyComparator = secondaryIndex.compareKeys;
			this.keyExtractor = secondaryIndex.keyFromRow;
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
		this.iterator = null;
		this.currentPath = null;
		this._isEof = true;
		this.currentValue = null;
		this.currentModKey = null;

		if (this.plan.equalityKey !== undefined) {
			// --- EQ Plan Initialization ---
			try {
				const keyToFind = this.plan.equalityKey;
				const path = this.targetTree.find(keyToFind);
				if (path.on) {
					// Key found - check if it truly matches (for secondary index)
					const { itemKey, itemValue } = this.extractKeyValueAt(path);
					if (itemKey !== null && this.checkPlan(itemKey)) {
						// Position directly on it
						this.currentPath = path;
						this.currentModKey = itemKey;
						this.currentValue = itemValue;
						this._isEof = !itemValue; // EOF if row data is null
					} else {
						// Key not found or check failed
						this._isEof = true;
					}
				} else {
					// Key not found
					this._isEof = true;
				}
			} catch (e) {
				errorLog("Error during EQ find in BTree iterator initialization: %O", e);
				this._isEof = true;
				throw e;
			}
			// No iterator needed or used for EQ plan
		} else {
			// --- Range or Full Scan Initialization ---
			try {
				const startKey = this.plan.lowerBound?.value;
				let startPath: Path<any, any> | null = null;

				if (startKey !== undefined) {
					startPath = this.targetTree.find(startKey);
					// Adjust start path based on GT vs GE if needed (digitree finds GE)
					if (this.plan.lowerBound?.op === IndexConstraintOp.GT && startPath.on) {
						// Need to start *after* this key
						const tempIterator = this.targetTree.ascending(startPath);
						const nextResult = tempIterator.next(); // Move one step
						startPath = nextResult.done ? null : nextResult.value;
					}
				} else {
					startPath = this.plan.descending ? this.targetTree.last() : this.targetTree.first();
				}

				if (startPath) {
					this.iterator = this.plan.descending
						? this.targetTree.descending(startPath)
						: this.targetTree.ascending(startPath);
					this.advanceIterator(); // Position on the first valid element
				} else {
					this._isEof = true; // No elements in range or tree empty
				}
			} catch (e) {
				errorLog("Error initializing Range/Full BTree iterator: %O", e);
				this._isEof = true;
				throw e;
			}
		}
	}

	// Advance is only used for Range/Full scans
	private advanceIterator(): void {
		if (!this.iterator) {
			this._isEof = true;
			return;
		}

		while (true) {
			const result = this.iterator.next();
			if (result.done) {
				this.currentPath = null;
				this.currentValue = null;
				this.currentModKey = null;
				this._isEof = true;
				return;
			}

			this.currentPath = result.value;
			const { itemKey, itemValue } = this.extractKeyValueAt(this.currentPath);

			if (itemKey === null) continue; // Skip if key extraction failed

			// Check bounds
			if (!this.checkPlanBounds(itemKey)) {
				// Exceeded bounds, stop iteration
				this.currentPath = null;
				this.currentValue = null;
				this.currentModKey = null;
				this._isEof = true;
				return;
			}

			// Found a valid item within bounds
			this.currentModKey = itemKey;
			this.currentValue = itemValue;
			this._isEof = !itemValue; // EOF if no row data associated (e.g., secondary index points to deleted row)

			// Stop if we found a valid row, otherwise continue loop to find next non-null row value
			if (this.currentValue) {
				return;
			}
		}
	}

	/** Checks if the key is within the plan's range bounds */
	private checkPlanBounds(key: ModificationKey): boolean {
		let firstColKey: SqlValue | null = null;
		if (this.plan.indexName === 'primary') {
			const btreeKey = key as BTreeKey;
			firstColKey = Array.isArray(btreeKey) ? (btreeKey[0] as SqlValue) : btreeKey;
		} else {
			const indexKeyPart = (key as [BTreeKey, bigint])[0];
			firstColKey = Array.isArray(indexKeyPart) ? (indexKeyPart[0] as SqlValue) : indexKeyPart;
		}

		if (firstColKey === null && (this.plan.lowerBound || this.plan.upperBound)) {
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
		return true;
	}

	/** Checks if the extracted key satisfies the plan's equality constraint */
	private checkPlan(key: ModificationKey): boolean {
		if (this.plan.equalityKey === undefined) {
			// Should not be called for non-EQ plans, but return true if it is
			return true;
		}

		// EQ scan: key must match exactly.
		// For secondary index, compare only the IndexKey part.
		const keyToCompare = this.plan.indexName === 'primary' ? (key as BTreeKey) : (key as [BTreeKey, bigint])[0];
		return this.keyComparator(keyToCompare, this.plan.equalityKey) === 0;
	}

	// No longer needed - bounds check handles this
	// /** Determines if iteration can stop early based on plan and current key */
	// private shouldStopIteration(key: ModificationKey): boolean { ... }

	async next(): Promise<void> {
		if (this._isEof) return;

		if (this.isEqPlanCursor) {
			// --- EQ Plan Next ---
			// After the first result (positioned in constructor), next always leads to EOF
			debugLog(`BaseLayerCursorInternal.next (EQ): Setting EOF. Old _isEof=${this._isEof}`);
			this.currentPath = null;
			this.currentValue = null;
			this.currentModKey = null;
			this._isEof = true;
			debugLog(`BaseLayerCursorInternal.next (EQ): Set EOF. New _isEof=${this._isEof}`);
		} else {
			// --- Range or Full Scan Next ---
			if (!this.iterator) {
				this._isEof = true; // Should not happen if not EOF initially
				return;
			}
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
