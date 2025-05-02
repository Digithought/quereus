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
import { createLogger } from '../../../common/logger.js'; // Import logger
import { safeJsonStringify } from '../../../util/serialization.js';

const log = createLogger('vtab:memory:layer:transaction-cursor'); // Create logger
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

// Helper type for merge action determination
type MergeAction = {
	useMod: boolean;
	useParent: boolean;
	advanceMod: boolean;
	advanceParent: boolean;
};

// Helper type for potential result extraction
type PotentialResult = {
	potentialKey: ModificationKey | null;
	potentialRow: MemoryTableRow | null;
	isDeletedHere: boolean;
	potentialLayerValue: ModificationValue | null;
};

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
				errorLog("TransactionLayerCursor: BTree iterator returned path with undefined value.");
				this.modEof = true;
				this.currentModKey = null;
				this.currentModValue = null;
			} else {
				this.currentModValue = value;
				// Extract key using the layer's configured extractor function
				this.currentModKey = this.modKeyExtractor(this.currentModValue);
				if (this.currentModKey === null) {
					// This indicates an issue with the extractor logic
					// Use namespaced error logger
					errorLog("Key extraction returned null.");
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

	/** Compares the BTreeKey parts of the current modification and parent keys */
	private compareKeysForMerge(): number | null {
		const modKey = this.currentModKey;
		const parentKey = this.parentKey;

		if (modKey === null || parentKey === null) {
			return null; // Cannot compare if one is null
		}

		return this.modKeyComparator(this.extractIndexKey(modKey), this.extractIndexKey(parentKey));
	}

	/** Determines which source(s) to use and advance based on comparison and EOF */
	private determineMergeAction(compareResult: number | null): MergeAction {
		const action: MergeAction = { useMod: false, useParent: false, advanceMod: false, advanceParent: false };

		if (this.modEof) { // Only parent has data
			action.useParent = true;
			action.advanceParent = true;
		} else if (this.parentEof) { // Only mods have data
			action.useMod = true;
			action.advanceMod = true;
		} else if (compareResult !== null) { // Both have data, compare keys
			// Compare keys based on scan direction
			const comparison = this.plan.descending ? -compareResult : compareResult;

			if (comparison === 0) { // Keys match (BTreeKey part)
				action.useMod = true; // Modification takes precedence
				action.advanceMod = true;
				action.advanceParent = true; // Advance parent past the matched key
			} else if (comparison < 0) { // Mod key comes first
				action.useMod = true;
				action.advanceMod = true;
				// Don't advance parent yet
			} else { // Parent key comes first
				action.useParent = true;
				action.advanceParent = true;
				// Don't advance mod yet
			}
		} else {
			// Error state if both not EOF but comparison failed (shouldn't happen with valid keys)
			errorLog("Invalid state during merge comparison (compareResult null despite non-EOF).");
			// Indicate an error state by not setting use/advance flags, leading to EOF in mergeNext
		}
		return action;
	}

	/** Extracts potential key/row from the chosen source */
	private getPotentialResult(action: MergeAction): PotentialResult {
		const result: PotentialResult = {
			potentialKey: null,
			potentialRow: null,
			isDeletedHere: false,
			potentialLayerValue: null,
		};

		if (action.useMod && this.currentModValue !== null) { // Ensure mod value exists
			result.potentialKey = this.currentModKey;
			result.potentialLayerValue = this.currentModValue;
			if (isDeletionMarker(this.currentModValue)) {
				result.isDeletedHere = true;
				result.potentialRow = null;
			} else {
				result.potentialRow = this.currentModValue as MemoryTableRow;
			}
		} else if (action.useParent) {
			result.potentialKey = this.parentKey;
			result.potentialRow = this.parentValue; // Can be null if parent had no row data?
			result.potentialLayerValue = null; // No value from *this* layer
		}
		return result;
	}

	/** Checks if a potential row is deleted either by marker or explicit rowid */
	private isEffectivelyDeleted(potentialResult: PotentialResult): boolean {
		if (potentialResult.isDeletedHere) {
			return true;
		}
		if (potentialResult.potentialRow && this.layer.getDeletedRowids().has(potentialResult.potentialRow._rowid_)) {
			return true;
		}
		return false;
	}

	/** Advances the underlying mod/parent iterators based on the action flags */
	private async advanceSources(action: MergeAction): Promise<void> {
		const advancePromises: Promise<void>[] = [];
		if (action.advanceMod) this.advanceModIterator(); // Mod is sync
		if (action.advanceParent) advancePromises.push(this.advanceParentCursor()); // Parent is async

		if (advancePromises.length > 0) {
			await Promise.all(advancePromises);
		}
	}

	/** Performs the core 2-way merge logic to find the next overall state */
	private async mergeNext(): Promise<void> {
		while (true) { // Loop until a valid, non-deleted item is found or EOF
			this._currentKey = null;
			this._currentRow = null;
			this._currentLayerValue = null;

			// --- 1. Check Overall EOF ---
			if (this.modEof && this.parentEof) {
				this._isEof = true;
				return;
			}

			// --- 2. Compare Keys & Determine Action ---
			const compareResult = this.compareKeysForMerge();
			const action = this.determineMergeAction(compareResult);

			// --- 3. Get Potential Result from Chosen Source ---
			const potential = this.getPotentialResult(action);

			// --- 4. Handle Error/Empty State ---
			// If no potential key was found (e.g., error in determineMergeAction or both sources empty unexpectedly)
			if (potential.potentialKey === null && !(this.modEof && this.parentEof)) {
				// Log error if this wasn't the expected EOF case handled above
				errorLog("Merge loop encountered state with no potential key despite not being EOF.");
				this._isEof = true;
				// Advance sources based on determination, even in error, to hopefully resolve state
				await this.advanceSources(action);
				return; // Exit as EOF due to error
			}
			// If potentialKey is null AND it's the EOF case, the loop exit is handled at the top.


			// --- 5. Check if Effectively Deleted ---
			if (potential.potentialKey && this.isEffectivelyDeleted(potential)) {
				// Advance sources and continue loop to find the next item
				await this.advanceSources(action);
				continue;
			}

			// --- 6. Check Plan Applicability ---
			if (potential.potentialKey && this.planApplies(potential.potentialKey)) {
				// Found the next valid item
				this._currentKey = potential.potentialKey;
				this._currentRow = potential.potentialRow;
				this._currentLayerValue = potential.potentialLayerValue;
				this._isEof = false;

				// Advance sources for the *next* iteration
				await this.advanceSources(action);
				return; // Yield the found item
			}

			// --- 7. Handle Plan Not Applying / Stopping Condition ---
			if (potential.potentialKey) { // Only proceed if we had a key
				// Item doesn't satisfy plan (e.g., out of bounds after merge)
				if (this.shouldStopOverallIteration(potential.potentialKey)) {
					// Stop iteration completely
					this._isEof = true;
					// Advance sources one last time
					await this.advanceSources(action);
					return;
				} else {
					// Plan doesn't apply, but haven't hit stopping condition yet.
					// Advance sources and continue the merge loop.
					await this.advanceSources(action);
					continue;
				}
			}

			// --- 8. Fallback / Loop Continuation ---
			// If we reached here without returning or continuing, it implies a state
			// where potentialKey might have been null initially (handled in step 1/4)
			// or some other edge case. Advancing sources is generally the correct action
			// to progress the state.
			await this.advanceSources(action);
			// Loop continues implicitly
		}
	}

	/** Check if the key satisfies the overall plan (mainly bounds and EQ check) */
	private planApplies(key: ModificationKey): boolean {
		// 1. Equality scan – fast path
		if (this.plan.equalityKey !== undefined) {
			const isEqual = this.modKeyComparator(this.extractIndexKey(key), this.plan.equalityKey) === 0;
			if (!isEqual) {
				warnLog(
					`Merged key ${safeJsonStringify(key)}'s comparable part does not match equality key ${safeJsonStringify(
						this.plan.equalityKey,
					)} in EQ scan.`,
				);
			}
			return isEqual;
		}

		// 2. Range / full scan
		const firstColKey = this.extractFirstColumnKey(key);

		if (firstColKey === null && (this.plan.lowerBound || this.plan.upperBound)) {
			warnLog('Could not extract first column key for range check.');
			return false;
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

		return true;
	}

	/** Check if iteration can stop based on the current merged key */
	private shouldStopOverallIteration(key: ModificationKey): boolean {
		// 1. Equality scans: stop when we pass the equality key.
		if (this.plan.equalityKey !== undefined) {
			const cmp = this.modKeyComparator(this.extractIndexKey(key), this.plan.equalityKey);
			if (this.plan.descending) return cmp < 0; // DESC: key < target means we passed it
			return cmp > 0; // ASC: key > target means we passed it
		}

		// 2. Range scans – check bounds relative to scan direction
		const firstColKey = this.extractFirstColumnKey(key);
		if (firstColKey === null && (this.plan.lowerBound || this.plan.upperBound)) {
			// Can't decide – continue scanning.
			return false;
		}

		if (!this.plan.descending) {
			// Ascending: stop if we exceed upper bound
			if (this.plan.upperBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.upperBound.value);
				return cmp > 0 || (cmp === 0 && this.plan.upperBound.op === IndexConstraintOp.LT);
			}
		} else {
			// Descending: stop if we go below lower bound
			if (this.plan.lowerBound && firstColKey !== null) {
				const cmp = compareSqlValues(firstColKey, this.plan.lowerBound.value);
				return cmp < 0 || (cmp === 0 && this.plan.lowerBound.op === IndexConstraintOp.GT);
			}
		}

		return false;
	}

	// Helper functions for key extraction to avoid duplication
	private extractIndexKey(key: ModificationKey): BTreeKey {
		// Returns the BTreeKey portion that should participate in comparisons.
		// For the primary index this is the key itself, for secondary indexes it's the first tuple element.
		return this.plan.indexName === 'primary' ? (key as BTreeKey) : (key as [BTreeKey, bigint])[0];
	}

	private extractFirstColumnKey(key: ModificationKey): SqlValue | null {
		// Extracts the *first* column value of the index key (needed for range checks).
		const indexKey = this.extractIndexKey(key);
		if (Array.isArray(indexKey)) {
			const first = indexKey[0];
			return Array.isArray(first) ? null : (first as SqlValue);
		}
		return indexKey as SqlValue;
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
