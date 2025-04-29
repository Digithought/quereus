import type { BTree, Path } from 'digitree';
import type { LayerCursorInternal } from './cursor.js';
import type { ScanPlan } from './scan-plan.js';
import type { TransactionLayer } from './transaction.js';
import type { MemoryTableRow, BTreeKey } from '../types.js';
import { compareSqlValues } from '../../../util/comparison.js';
import type { Layer, ModificationKey, ModificationValue, DeletionMarker } from './interface.js';
import { DELETED } from './constants.js';
import type { SqlValue } from '../../../common/types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { isDeletionMarker } from './interface.js'; // Import type guard

/**
 * Internal cursor for iterating a TransactionLayer.
 * It merges modifications from its layer with the results from its parent cursor.
 */
export class TransactionLayerCursorInternal implements LayerCursorInternal {
	private readonly layer: TransactionLayer;
	private readonly plan: ScanPlan;
	private readonly parentCursor: LayerCursorInternal;
	private readonly modificationTree: BTree<ModificationKey, ModificationValue> | null;
	// Comparator for the *keys* used in this layer/plan (primary or secondary)
	private readonly modKeyComparator: (a: BTreeKey, b: BTreeKey) => number;
	// Extractor for the *key* from a value stored in this layer's BTree
	private readonly modKeyExtractor: ((value: ModificationValue) => ModificationKey) | null;

	private modIterator: IterableIterator<Path<ModificationKey, ModificationValue>> | null = null;
	private currentModPath: Path<ModificationKey, ModificationValue> | null = null;
	private currentModKey: ModificationKey | null = null; // Key from mod tree (BTreeKey or [BTreeKey, bigint])
	private currentModValue: ModificationValue | null = null; // Raw value from mod tree
	private modEof: boolean = true;

	private parentKey: ModificationKey | null = null; // Key from parent cursor
	private parentValue: MemoryTableRow | null = null; // Actual row data from parent
	private parentEof: boolean = true;

	// Overall cursor state
	private _currentKey: ModificationKey | null = null; // The effective key of the current merged item
	private _currentRow: MemoryTableRow | null = null; // The *effective* row data
	private _currentLayerValue: ModificationValue | null = null; // Value from *this* layer's mod tree if it determined the current state
	private _isEof: boolean = true;

	constructor(layer: TransactionLayer, plan: ScanPlan, parentCursor: LayerCursorInternal) {
		this.layer = layer;
		this.plan = plan;
		this.parentCursor = parentCursor;
		this.modificationTree = layer.getModificationTree(plan.indexName);

		// Get the comparator for the specific key type used by the index (BTreeKey)
		this.modKeyComparator = layer.getKeyComparator(plan.indexName);
		// Get the extractor that produces the key (ModificationKey) from the BTree value (ModificationValue)
		this.modKeyExtractor = this.modificationTree
			? layer.getKeyExtractor(plan.indexName) // Use layer's helper
			: null; // Null extractor if no tree

		this.initialize();
	}

	private initialize(): void {
		if (this.modificationTree && this.modKeyExtractor) {
			// Initialize iterator for the modification BTree for this layer
			let modStartPath: Path<ModificationKey, ModificationValue> | null = null;
			if (this.plan.equalityKey !== undefined) {
				// For EQ scans, optimize the mod iterator start.
				// Use the key directly with the BTree's find method
				modStartPath = this.modificationTree.find(this.plan.equalityKey);
			} else {
				modStartPath = this.plan.descending ? this.modificationTree.last() : this.modificationTree.first();
			}

			if (modStartPath) {
				this.modIterator = this.plan.descending
					? this.modificationTree.descending(modStartPath)
					: this.modificationTree.ascending(modStartPath);
				this.advanceModIterator(); // Position on first mod item
			} else {
				this.modEof = true;
			}
		} else {
			this.modEof = true; // No modifications in this layer for this index or no extractor
		}

		// Fetch initial state from parent
		this.parentEof = this.parentCursor.isEof();
		if (!this.parentEof) {
			this.parentKey = this.parentCursor.getCurrentModificationKey();
			this.parentValue = this.parentCursor.getCurrentRow();
		}

		// Perform initial merge step to set the first overall state
		// Use Promise.resolve().then() to avoid making initialize async
		Promise.resolve().then(() => this.mergeNext());
	}

	/** Advances the modification iterator and updates its state */
	private advanceModIterator(): void {
		if (!this.modIterator || !this.modificationTree || !this.modKeyExtractor) {
			this.modEof = true;
			this.currentModPath = null;
			this.currentModKey = null;
			this.currentModValue = null;
			return;
		}
		const nextResult = this.modIterator.next();
		if (nextResult.done) {
			this.modEof = true;
			this.currentModPath = null;
			this.currentModKey = null;
			this.currentModValue = null;
		} else {
			this.modEof = false;
			this.currentModPath = nextResult.value;
			const value = this.modificationTree.at(this.currentModPath);
			if (value === undefined) {
				// Should not happen if path is valid from iterator
				console.error("TransactionLayerCursor: BTree iterator returned path with undefined value.");
				this.modEof = true;
				this.currentModKey = null;
				this.currentModValue = null;
			} else {
				this.currentModValue = value;
				// Extract key using the layer's configured extractor function
				this.currentModKey = this.modKeyExtractor(this.currentModValue);
				if (this.currentModKey === null) {
					// This indicates an issue with the extractor logic
					console.error("TransactionLayerCursor: Key extraction returned null.");
					this.modEof = true; // Treat as EOF if key extraction fails
				}
			}
		}
	}

	/** Advances the parent cursor and updates its state */
	private async advanceParentCursor(): Promise<void> {
		await this.parentCursor.next();
		this.parentEof = this.parentCursor.isEof();
		if (this.parentEof) {
			this.parentKey = null;
			this.parentValue = null;
		} else {
			this.parentKey = this.parentCursor.getCurrentModificationKey();
			this.parentValue = this.parentCursor.getCurrentRow();
		}
	}

	/** Performs the core 2-way merge logic to find the next overall state */
	private async mergeNext(): Promise<void> {
		while (true) { // Loop until a valid, non-deleted item is found or EOF
			this._currentKey = null;
			this._currentRow = null;
			this._currentLayerValue = null;

			const modKey = this.currentModKey;
			const parentKey = this.parentKey;

			let compare: number | null = null;
			if (modKey && parentKey) {
				// Compare the BTreeKey parts of the ModificationKeys
				const modBTreeKey = this.plan.indexName === 'primary' ? (modKey as BTreeKey) : (modKey as [BTreeKey, bigint])[0];
				const parentBTreeKey = this.plan.indexName === 'primary' ? (parentKey as BTreeKey) : (parentKey as [BTreeKey, bigint])[0];
				compare = this.modKeyComparator(modBTreeKey, parentBTreeKey);
			}

			let useMod = false;
			let useParent = false;
			let advanceMod = false;
			let advanceParent = false;

			if (this.modEof && this.parentEof) {
				this._isEof = true;
				return; // Both sources exhausted
			} else if (this.modEof) {
				useParent = true; // Only parent has data
				advanceParent = true;
			} else if (this.parentEof) {
				useMod = true; // Only mods have data
				advanceMod = true;
			} else if (compare !== null) {
				// Compare keys based on scan direction
				const comparisonResult = this.plan.descending ? -compare : compare;

				if (comparisonResult === 0) { // Keys match (based on BTreeKey part)
					useMod = true; // Modification takes precedence
					advanceMod = true;
					advanceParent = true; // Advance parent past the matched key
				} else if (comparisonResult < 0) { // Mod key comes first
					useMod = true;
					advanceMod = true;
					// Don't advance parent yet
				} else { // Parent key comes first
					useParent = true;
					advanceParent = true;
					// Don't advance mod yet
				}
			} else {
				// Should not happen if both are not EOF and keys are valid
				this._isEof = true;
				console.error("TransactionLayerCursor: Invalid state during merge comparison (modKey/parentKey null or comparator failed?).");
				return;
			}

			let potentialRow: MemoryTableRow | null = null;
			let potentialKey: ModificationKey | null = null;
			let isDeletedHere = false;

			if (useMod && this.currentModValue !== null) { // Ensure mod value exists
				potentialKey = this.currentModKey; // This is ModificationKey
				this._currentLayerValue = this.currentModValue; // Store raw mod value
				if (isDeletionMarker(this.currentModValue)) {
					isDeletedHere = true;
					potentialRow = null; // Row data is null for delete
				} else {
					potentialRow = this.currentModValue as MemoryTableRow;
				}
			} else if (useParent) {
				potentialKey = this.parentKey; // This is ModificationKey
				potentialRow = this.parentValue; // Use row data from parent (already MemoryTableRow | null)
				this._currentLayerValue = null; // No value from *this* layer
			}

			// Advance the chosen source(s) *before* processing the potential result
			// Store promises to await them together if needed
			const advancePromises: Promise<void>[] = [];
			if (advanceMod) this.advanceModIterator(); // mod is sync
			if (advanceParent) advancePromises.push(this.advanceParentCursor());
			if (advancePromises.length > 0) await Promise.all(advancePromises);


			// --- Process the potential result ---

			// Skip if this item was marked as deleted in this layer
			if (isDeletedHere) {
				continue; // Loop again to find next merge result
			}

			// If we got a valid potential row (not deleted here), check if its *rowid*
			// is in this layer's explicit deleted set.
			if (potentialRow && this.layer.getDeletedRowids().has(potentialRow._rowid_)) {
				// Even if the key matched a non-delete modification, the rowid might have been
				// deleted separately in this layer.
				continue; // Skip this row, it's explicitly deleted in this layer
			}


			// Found a potentially valid, non-deleted item
			if (potentialKey) {
				// Check plan satisfaction *after* merge and deletion checks.
				// This is crucial because mods might bring an item into range,
				// or parent might provide one, or a mod might delete an item.
				if (this.planApplies(potentialKey)) {
					this._currentKey = potentialKey;
					this._currentRow = potentialRow; // Can be null if useParent && parentValue was null (shouldn't happen if parentKey is valid?)
					this._isEof = false;
					return; // Found the next valid item
				} else {
					// Item doesn't satisfy plan (e.g., out of bounds after merge)
					// Stop if we know no further items can match based on the current key.
					if (this.shouldStopOverallIteration(potentialKey)) {
						this._isEof = true;
						return;
					}
					// Otherwise, continue the merge loop
				}

			} else if (this.modEof && this.parentEof) {
				// This handles the case where the loop ends because both sources became EOF
				// after the last advance.
				this._isEof = true;
				return;
			}
			// If potentialKey was null, or potentialRow was null (e.g., from a deletion marker
			// processed above), or plan didn't apply and we didn't stop, continue the loop.
		}
	}

	/** Check if the key satisfies the overall plan (mainly bounds and EQ check) */
	private planApplies(key: ModificationKey): boolean {
		// Re-use checkPlan logic similar to BaseLayerCursor, adapted for ModificationKey

		// Ensure plan's equality key exists before proceeding with EQ check
		if (this.plan.equalityKey === undefined) {
			// Range/Full Scan: Check bounds.
			let firstColKey: SqlValue | null = null;
			if (this.plan.indexName === 'primary') {
				if (Array.isArray(key)) {
					firstColKey = key.length > 0 && !Array.isArray(key[0]) ? key[0] : null;
				} else {
					firstColKey = key as SqlValue;
				}
			} else {
				// Secondary: key is [IndexKey, rowid]
				const indexKeyPart = (key as [BTreeKey, bigint])[0];
				if (Array.isArray(indexKeyPart)) {
					firstColKey = indexKeyPart.length > 0 && !Array.isArray(indexKeyPart[0]) ? indexKeyPart[0] : null;
				} else {
					firstColKey = indexKeyPart as SqlValue;
				}
			}

			if (firstColKey === null && (this.plan.lowerBound || this.plan.upperBound)) {
				console.warn("TransactionLayerCursor: Could not extract first column key for range check.");
				return false; // Cannot satisfy bounds if key cannot be compared
			}

			if (this.plan.lowerBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.lowerBound.value);
				if (cmp < 0 || (cmp === 0 && this.plan.lowerBound.op === IndexConstraintOp.GT)) {
					return false;
				}
			}
			if (this.plan.upperBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.upperBound.value);
				if (cmp > 0 || (cmp === 0 && this.plan.upperBound.op === IndexConstraintOp.LT)) {
					return false;
				}
			}
			return true; // Passed bounds checks or no bounds
		} else {
			// EQ Scan: Check if the key's BTreeKey part matches the equality key.
			const keyToCompare = this.plan.indexName === 'primary' ? (key as BTreeKey) : (key as [BTreeKey, bigint])[0];

			// Use the specific BTreeKey comparator
			const isEqual = this.modKeyComparator(keyToCompare, this.plan.equalityKey) === 0;

			if (!isEqual) {
				// This could happen during the merge if the modIterator or parentCursor
				// moves past the equality key due to how find() + iteration works.
				// It's not necessarily an error, just means this specific merged key doesn't match.
				// console.warn(`TransactionLayerCursor: Merged key ${JSON.stringify(key)}'s comparable part does not match equality key ${JSON.stringify(this.plan.equalityKey)} in EQ scan.`);
			}
			return isEqual; // Return true only if keys actually match
		}
	}

	/** Check if iteration can stop based on the current merged key */
	private shouldStopOverallIteration(key: ModificationKey): boolean {
		// Re-use shouldStopIteration logic similar to BaseLayerCursor

		// EQ scan stopping logic: If the current key is past the equality key, stop.
		if (this.plan.equalityKey !== undefined) {
			const keyToCompare = this.plan.indexName === 'primary' ? (key as BTreeKey) : (key as [BTreeKey, bigint])[0];
			const cmp = this.modKeyComparator(keyToCompare, this.plan.equalityKey);
			if (this.plan.descending && cmp < 0) return true; // EQ DESC: current key is less than target
			if (!this.plan.descending && cmp > 0) return true; // EQ ASC: current key is greater than target
			// If cmp === 0, we *don't* stop yet in an EQ scan, as there might be more matching keys
			// (especially relevant for non-unique indexes or secondary indexes where multiple rowids share the same index key).
		}

		// Range scan stopping logic:
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
			return false; // Cannot optimize stop if key cannot be compared
		}

		if (!this.plan.descending) { // Ascending scan
			if (this.plan.upperBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.upperBound.value);
				if (cmp > 0 || (cmp === 0 && this.plan.upperBound.op === IndexConstraintOp.LT)) {
					return true; // Gone past upper bound
				}
			}
		} else { // Descending scan
			if (this.plan.lowerBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.lowerBound.value);
				if (cmp < 0 || (cmp === 0 && this.plan.lowerBound.op === IndexConstraintOp.GT)) {
					return true; // Gone past lower bound
				}
			}
		}
		return false;
	}


	async next(): Promise<void> {
		if (!this._isEof) {
			await this.mergeNext();
		}
	}

	getCurrentRow(): MemoryTableRow | null {
		return this._isEof ? null : this._currentRow;
	}

	getCurrentModificationKey(): ModificationKey | null {
		// Return the key (primary or [secondary, rowid]) of the current merged item
		return this._isEof ? null : this._currentKey;
	}

	getCurrentLayerValue(): ModificationValue | null {
		// Returns the value from *this* layer's mod tree if it contributed
		// to the current merged result (i.e., if `useMod` was true in mergeNext).
		return this._isEof ? null : this._currentLayerValue;
	}

	isEof(): boolean {
		return this._isEof;
	}

	close(): void {
		// Close self and parent
		this.modIterator = null; // Release iterator
		this.parentCursor.close(); // Recursively close parent
		this._isEof = true;
		// Clear other state just in case
		this.currentModPath = null;
		this.currentModKey = null;
		this.currentModValue = null;
		this.parentKey = null;
		this.parentValue = null;
		this._currentKey = null;
		this._currentRow = null;
		this._currentLayerValue = null;
	}
}
