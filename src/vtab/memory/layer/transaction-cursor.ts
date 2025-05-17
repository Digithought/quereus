import type { BTree, Path } from 'digitree';
import type { LayerCursorInternal } from './cursor.js';
import type { ScanPlan } from './scan-plan.js';
import type { TransactionLayer } from './transaction.js';
import type { MemoryTableRow, BTreeKey, ModificationKey, ModificationValue } from '../types.js';
// import { compareSqlValues } from '../../../util/comparison.js'; // Unused
import { isDeletionMarker } from './interface.js';
// import { createLogger } from '../../../common/logger.js'; // Unused
// import { safeJsonStringify } from '../../../util/serialization.js'; // Unused
// import type { SqlValue } from '../../../common/types.js'; // Unused
// import { IndexConstraintOp } from '../../../common/constants.js'; // Unused
import type { TableSchema } from '../../../schema/table.js';
import type { MemoryTableManager } from './manager.js';

// Loggers removed as they were unused

type MergeAction = { useMod: boolean; useParent: boolean; advanceMod: boolean; advanceParent: boolean; };
type PotentialResult = { potentialKey: ModificationKey | null; potentialRow: MemoryTableRow | null; isDeletedHere: boolean; };

export class TransactionLayerCursorInternal implements LayerCursorInternal {
	private readonly layer: TransactionLayer;
	private readonly plan: ScanPlan;
	private readonly parentCursor: LayerCursorInternal;
	private readonly modificationTree: BTree<ModificationKey, ModificationValue> | null;
	private readonly btreeKeyComparator: (a: BTreeKey, b: BTreeKey) => number;
	private readonly modificationKeyComparator: (a: ModificationKey, b: ModificationKey) => number;
	private readonly modKeyExtractor: ((value: ModificationValue) => ModificationKey) | null;
	private readonly tableManager: MemoryTableManager;

	private modBTreeIterator: IterableIterator<Path<ModificationKey, ModificationValue>> | null = null;
	private currentModResultDone: boolean = true;
	private currentModValue: ModificationValue | undefined = undefined;
	private currentModKey: ModificationKey | null = null;

	private parentResultDone: boolean = true;
	private parentValueObject: MemoryTableRow | null = null;
	private parentModKey: ModificationKey | null = null;

	private _currentKey: ModificationKey | null = null;
	private _currentRowObject: MemoryTableRow | null = null;
	private _isEof: boolean = true;
	private readonly tableSchema: TableSchema;

	constructor(layer: TransactionLayer, plan: ScanPlan, parentCursor: LayerCursorInternal, tableManager: MemoryTableManager) {
		this.layer = layer;
		this.plan = plan;
		this.parentCursor = parentCursor;
		this.tableManager = tableManager;
		this.modificationTree = layer.getModificationTree(plan.indexName);
		this.modKeyExtractor = this.modificationTree ? layer.getKeyExtractor(plan.indexName) : null;
		this.btreeKeyComparator = layer.getKeyComparator(plan.indexName);
		this.modificationKeyComparator = layer.getComparator(plan.indexName);
		this.tableSchema = layer.getSchema();
		this.initializeIterators();
	}

	private async initializeIterators(): Promise<void> {
		if (this.modificationTree) {
			let modStartPath: Path<ModificationKey, ModificationValue> | null = null;
			if (this.plan.equalityKey !== undefined) {
				modStartPath = this.modificationTree.find(this.plan.equalityKey as any);
			} else if (this.plan.lowerBound?.value !== undefined) {
				modStartPath = this.modificationTree.find(this.plan.lowerBound.value as any);
				// TODO: Adjust for GT if op is GT
			} else {
				modStartPath = this.plan.descending ? this.modificationTree.last() : this.modificationTree.first();
			}
			if (modStartPath) {
				this.modBTreeIterator = this.plan.descending
					? this.modificationTree.descending(modStartPath)
					: this.modificationTree.ascending(modStartPath);
			}
		}
		await this.advanceMod();
		await this.advanceParent();
		await this.mergeNextState();
	}

	private async advanceMod(): Promise<void> {
		this.currentModValue = undefined; this.currentModKey = null; this.currentModResultDone = true;
		if (this.modBTreeIterator) {
			const result = this.modBTreeIterator.next();
			if (!result.done && result.value && this.modificationTree && this.modKeyExtractor) {
				this.currentModValue = this.modificationTree.at(result.value);
				if (this.currentModValue) this.currentModKey = this.modKeyExtractor(this.currentModValue);
				this.currentModResultDone = false;
			}
		}
	}

	private async advanceParent(): Promise<void> {
		this.parentValueObject = null; this.parentModKey = null; this.parentResultDone = true;
		if (!this.parentCursor.isEof()) {
			this.parentValueObject = this.parentCursor.getCurrentRowObject();
			this.parentModKey = this.parentCursor.getCurrentModificationKey();
			this.parentResultDone = false;
		} else {
		    // Ensure if parentCursor was already EOF, we get its final state if it had one
		    this.parentValueObject = this.parentCursor.getCurrentRowObject(); // Might be null
		    this.parentModKey = this.parentCursor.getCurrentModificationKey(); // Might be null
		}
	}

	private determineMergeAction(): MergeAction {
		const action: MergeAction = { useMod: false, useParent: false, advanceMod: false, advanceParent: false };
		if (this.currentModResultDone || !this.currentModKey) { action.useParent = true; action.advanceParent = true; }
		else if (this.parentResultDone || !this.parentModKey) { action.useMod = true; action.advanceMod = true; }
		else {
			const cmp = this.modificationKeyComparator(this.currentModKey, this.parentModKey);
			const effectiveCmp = this.plan.descending ? -cmp : cmp;
			if (effectiveCmp === 0) { action.useMod = true; action.advanceMod = true; action.advanceParent = true; }
			else if (effectiveCmp < 0) { action.useMod = true; action.advanceMod = true; }
			else { action.useParent = true; action.advanceParent = true; }
		}
		return action;
	}

	private getPotentialResult(action: MergeAction): PotentialResult {
		const result: PotentialResult = { potentialKey: null, potentialRow: null, isDeletedHere: false };
		if (action.useMod && this.currentModValue) {
			result.potentialKey = this.currentModKey;
			if (isDeletionMarker(this.currentModValue)) { result.isDeletedHere = true; result.potentialRow = null; }
			else { result.potentialRow = this.currentModValue as MemoryTableRow; }
		} else if (action.useParent && this.parentValueObject) {
			result.potentialKey = this.parentModKey;
			result.potentialRow = this.parentValueObject;
		}
		return result;
	}

	private isEffectivelyDeleted(potential: PotentialResult): boolean {
		if (potential.isDeletedHere) return true;
		if (potential.potentialRow && this.layer.getDeletedRowids().has(potential.potentialRow[0])) return true;
		return false;
	}

	private planApplies(key: ModificationKey): boolean {
		return this.tableManager.planAppliesToKeyForLayer(this.plan, key, this.btreeKeyComparator, this.tableSchema);
	}

	private async mergeNextState(): Promise<void> {
		this._isEof = false; // Assume not EOF until proven
		while (true) {
			this._currentKey = null; this._currentRowObject = null;
			if ((this.currentModResultDone || !this.currentModKey) && (this.parentResultDone || !this.parentModKey)) {
				this._isEof = true; return;
			}
			const action = this.determineMergeAction();
			const potential = this.getPotentialResult(action);

			if (potential.potentialKey && this.isEffectivelyDeleted(potential)) {
				if (action.advanceMod) await this.advanceMod();
				if (action.advanceParent) { await this.parentCursor.next(); await this.advanceParent(); }
				continue;
			}
			if (potential.potentialKey && this.planApplies(potential.potentialKey)) {
				this._currentKey = potential.potentialKey;
				this._currentRowObject = potential.potentialRow;
				if (action.advanceMod) await this.advanceMod();
				if (action.advanceParent) { await this.parentCursor.next(); await this.advanceParent(); }
				return; // Found item
			}
			// Item did not apply to plan, or was null, advance and retry
			if (action.advanceMod) await this.advanceMod(); else if (action.advanceParent) { await this.parentCursor.next(); await this.advanceParent(); } else { this._isEof = true; return; /* Should not happen if determineMergeAction is correct*/ }
		}
	}

	async next(): Promise<void> { if (!this._isEof) await this.mergeNextState(); }
	getCurrentRowObject(): MemoryTableRow | null { return this._isEof ? null : this._currentRowObject; }
	getCurrentModificationKey(): ModificationKey | null { return this._isEof ? null : this._currentKey; }
	isEof(): boolean { return this._isEof; }
	close(): void { this.modBTreeIterator = null; this.parentCursor.close(); this._isEof = true; }
}
