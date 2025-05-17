import type { BTree, Path } from 'digitree';
import type { LayerCursorInternal } from './cursor.js';
import type { ScanPlan } from './scan-plan.js';
import type { BaseLayer } from './base.js';
import type { MemoryTableRow, BTreeKey, ModificationKey } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import type { SqlValue } from '../../../common/types.js';
import { createLogger } from '../../../common/logger.js';
import type { TableSchema } from '../../../schema/table.js';

const log = createLogger('vtab:memory:layer:base-cursor');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

export class BaseLayerCursorInternal implements LayerCursorInternal {
	private readonly layer: BaseLayer;
	private readonly plan: ScanPlan;
	private readonly targetTree: BTree<BTreeKey, MemoryTableRow> | BTree<[BTreeKey, bigint], [BTreeKey, bigint]>;
	private readonly keyComparator: (a: BTreeKey, b: BTreeKey) => number;
	// keyExtractor was removed as unused

	private iterator: IterableIterator<Path<any, any>> | null = null;
	private currentPath: Path<any, any> | null = null;
	private _isEof: boolean = true;
	private currentValue: MemoryTableRow | null = null; // Stores [rowid, data_array] | null
	private currentModKey: ModificationKey | null = null;
	private isEqPlanCursor: boolean = false;
	private readonly tableSchema: TableSchema;

	constructor(layer: BaseLayer, plan: ScanPlan) {
		this.layer = layer;
		this.plan = plan;
		this.tableSchema = layer.getSchema();
		this.isEqPlanCursor = plan.equalityKey !== undefined;

		if (plan.indexName === 'primary') {
			this.targetTree = layer.primaryTree as BTree<BTreeKey, MemoryTableRow>;
			this.keyComparator = layer.compareKeys;
		} else {
			const secondaryIndex = layer.secondaryIndexes.get(plan.indexName);
			if (!secondaryIndex) {
				throw new Error(`BaseLayerCursor: Secondary index '${plan.indexName}' not found.`);
			}
			this.targetTree = secondaryIndex.data;
			this.keyComparator = secondaryIndex.compareKeys;
		}
		this.initializeIterator();
	}

	private extractKeyValueAt(path: Path<any, any>): { itemKey: ModificationKey | null, itemValue: MemoryTableRow | null } {
		let itemValue: MemoryTableRow | null = null;
		let itemKey: ModificationKey | null = null;
		if (this.plan.indexName === 'primary') {
			const rowTuple = (this.targetTree as BTree<BTreeKey, MemoryTableRow>).at(path);
			if (rowTuple) {
				itemValue = rowTuple;
				try { itemKey = this.layer.keyFromEntry(rowTuple); } catch (e) {
					warnLog("Failed to extract primary key from value at path: %O", e);
				}
			}
		} else {
			const secondaryEntry = (this.targetTree as BTree<[BTreeKey, bigint], [BTreeKey, bigint]>).at(path);
			if (secondaryEntry) {
				itemKey = secondaryEntry;
				const rowid = secondaryEntry[1];
				const primaryKeyForRow = this.layer.rowidToKeyMap?.get(rowid) ?? (this.tableSchema.primaryKeyDefinition.length === 0 ? rowid : null);
				if (primaryKeyForRow !== null) {
					itemValue = this.layer.primaryTree.get(primaryKeyForRow) ?? null;
				} else {
					warnLog(`Could not find PK for rowid %s from secondary index %s.`, rowid, this.plan.indexName);
				}
			}
		}
		return { itemKey, itemValue };
	}

	private initializeIterator(): void {
		this.iterator = null; this.currentPath = null; this._isEof = true; this.currentValue = null; this.currentModKey = null;
		if (this.plan.equalityKey !== undefined) {
			try {
				const path = this.targetTree.find(this.plan.equalityKey as any);
				if (path.on) {
					const { itemKey, itemValue } = this.extractKeyValueAt(path);
					if (itemValue && itemKey && this.planAppliesToKey(this.plan, itemKey, this.keyComparator, this.tableSchema)) {
						this.currentPath = path; this.currentModKey = itemKey; this.currentValue = itemValue; this._isEof = false;
					} else { this._isEof = true; }
				} else { this._isEof = true; }
			} catch (e) { errorLog("EQ find error: %O", e); this._isEof = true; }
		} else {
			try {
				let startPath: Path<any, any> | null = null;
				if (this.plan.lowerBound?.value !== undefined) {
					startPath = this.targetTree.find(this.plan.lowerBound.value as any);
					if (this.plan.lowerBound.op === IndexConstraintOp.GT && startPath?.on) {
						const tempIter = (this.targetTree as BTree<any,any>).ascending(startPath); tempIter.next(); const nextR = tempIter.next(); startPath = nextR.done ? null : nextR.value;
					}
				} else { startPath = this.plan.descending ? this.targetTree.last() : this.targetTree.first(); }
				if (startPath) {
					this.iterator = this.plan.descending ? (this.targetTree as BTree<any,any>).descending(startPath) : (this.targetTree as BTree<any,any>).ascending(startPath);
					this.advanceIterator();
				} else { this._isEof = true; }
			} catch (e) { errorLog("Range/Full scan init error: %O", e); this._isEof = true; }
		}
	}

	private advanceIterator(): void {
		if (!this.iterator) { this._isEof = true; return; }
		while (true) {
			const result = this.iterator.next();
			if (result.done) { this.currentPath = null; this.currentValue = null; this.currentModKey = null; this._isEof = true; return; }
			this.currentPath = result.value;
			const { itemKey, itemValue } = this.extractKeyValueAt(this.currentPath);
			if (!itemKey) continue;
			if (!this.planAppliesToKey(this.plan, itemKey, this.keyComparator, this.tableSchema)) {
				this.currentPath = null; this.currentValue = null; this.currentModKey = null; this._isEof = true; return;
			}
			this.currentModKey = itemKey; this.currentValue = itemValue;
			this._isEof = !itemValue; // EOF if actual row data is null (e.g. secondary index points to deleted/non-existent PK)
			if (this.currentValue) return; // Found a valid row (with data)
		}
	}

	private planAppliesToKey(plan: ScanPlan, key: ModificationKey, cmpFn: (a:BTreeKey,b:BTreeKey)=>number, _schema: TableSchema): boolean {
		const keyForComp = plan.indexName === 'primary' ? key as BTreeKey : (key as [BTreeKey, bigint])[0];
		if (plan.equalityKey !== undefined) return cmpFn(keyForComp, plan.equalityKey) === 0;
		const firstColKey = this.extractFirstColumnFromKey(key, plan.indexName === 'primary');
		if (firstColKey === null && (plan.lowerBound || plan.upperBound)) return false;
		if (plan.lowerBound && firstColKey !== null) { const cmp = compareSqlValues(firstColKey, plan.lowerBound.value); if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false; }
		if (plan.upperBound && firstColKey !== null) { const cmp = compareSqlValues(firstColKey, plan.upperBound.value); if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false; }
		return true;
	}

	private extractFirstColumnFromKey(key: ModificationKey, isPrimary: boolean): SqlValue | null {
		const bKey = isPrimary ? key as BTreeKey : (key as [BTreeKey, bigint])[0];
		return Array.isArray(bKey) ? (bKey[0] as SqlValue) : bKey as SqlValue;
	}

	async next(): Promise<void> {
		if (this._isEof) return;
		if (this.isEqPlanCursor) { this._isEof = true; this.currentPath = null; this.currentValue = null; this.currentModKey = null; return; }
		if (!this.iterator) { this._isEof = true; return; }
		this.advanceIterator();
	}

	getCurrentRowObject(): MemoryTableRow | null { return this._isEof ? null : this.currentValue; }
	getCurrentModificationKey(): ModificationKey | null { return this._isEof ? null : this.currentModKey; }
	isEof(): boolean { return this._isEof; }
	close(): void { this.iterator = null; this.currentPath = null; this.currentValue = null; this.currentModKey = null; this._isEof = true; }
}
