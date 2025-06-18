import type { ScanPlan } from './scan-plan.js';
import type { BaseLayer } from './base.js';
import type { BTreeKey, BTreeKeyForPrimary, BTreeKeyForIndex } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { StatusCode, type Row } from '../../../common/types.js';
import { safeIterate } from './safe-iterate.js';
import { QuereusError } from '../../../common/errors.js';

export async function* scanBaseLayer(
	layer: BaseLayer,
	plan: ScanPlan
): AsyncIterable<Row> {
	const { primaryKeyExtractorFromRow: keyFromEntry, primaryKeyComparator } = layer.getPkExtractorsAndComparators(layer.getSchema());
	const isEqPlan = plan.equalityKey !== undefined;

	const planAppliesToKey = (key: BTreeKey, keyIsIndexKey: boolean): boolean => {
		const comparator = keyIsIndexKey
			? layer.secondaryIndexes.get(plan.indexName)?.compareKeys
			: primaryKeyComparator;
		if (!comparator) return true;

		if (plan.equalityKey !== undefined) return comparator(key, plan.equalityKey) === 0;

		const keyForBoundComparison = Array.isArray(key) ? key[0] : key;
		if (plan.lowerBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
			const cmp = compareSqlValues(keyForBoundComparison, plan.lowerBound.value);
			if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
		}
		if (plan.upperBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
			const cmp = compareSqlValues(keyForBoundComparison, plan.upperBound.value);
			if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
		}
		return true;
	};

	if (plan.indexName === 'primary') {
		const tree = layer.primaryTree; // BTree<BTreeKeyForPrimary, PrimaryModificationValue> from inheritree

		if (isEqPlan && plan.equalityKey !== undefined) {
			const value = tree.get(plan.equalityKey as BTreeKeyForPrimary);
			if (value && planAppliesToKey(plan.equalityKey as BTreeKeyForPrimary, false)) {
				yield value as Row;
			}
			return;
		}

		// Determine start key for range scans
		let startKey: { value: BTreeKeyForPrimary } | undefined;
		if (plan.lowerBound) {
			startKey = { value: plan.lowerBound.value as BTreeKeyForPrimary };
		}

		// Create mutation-safe iterator with range support
		for await (const value of safeIterate(tree, !plan.descending, startKey)) {
			const row = value as Row;
			const primaryKey = keyFromEntry(row);
			if (!planAppliesToKey(primaryKey, false)) {
				// If we're doing an ascending scan and we've passed the upper bound, we can break early
				if (!plan.descending && plan.upperBound) {
					const keyForComparison = Array.isArray(primaryKey) ? primaryKey[0] : primaryKey;
					const cmp = compareSqlValues(keyForComparison, plan.upperBound.value);
					if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
						break;
					}
				}
				continue;
			}
			yield row;
		}
	} else { // Secondary Index Scan
		const secondaryIndex = layer.secondaryIndexes.get(plan.indexName);
		if (!secondaryIndex) throw new QuereusError(`Secondary index '${plan.indexName}' not found in BaseLayer.`, StatusCode.INTERNAL);

		const indexTree = secondaryIndex.data; // BTree<BTreeKeyForIndex, MemoryIndexEntry> from inheritree

		if (isEqPlan && plan.equalityKey !== undefined) {
			const indexEntry = indexTree.get(plan.equalityKey as BTreeKeyForIndex);
			if (indexEntry && planAppliesToKey(indexEntry.indexKey, true)) {
				for (const pk of indexEntry.primaryKeys) {
					const value = layer.primaryTree.get(pk);
					if (value) {
						yield value as Row;
					}
				}
			}
			return;
		}

		// Use mutation-safe iterator for secondary index iteration with range support
		const isAscending = !plan.descending;

		// Determine start key for range scans on secondary index
		let startKey: { value: BTreeKeyForIndex } | undefined;
		if (plan.lowerBound) {
			startKey = { value: plan.lowerBound.value as BTreeKeyForIndex };
		}

		for await (const indexEntry of safeIterate(indexTree, isAscending, startKey)) {
			if (!planAppliesToKey(indexEntry.indexKey, true)) {
				// Early termination for ascending scans past upper bound
				if (isAscending && plan.upperBound) {
					const keyForComparison = Array.isArray(indexEntry.indexKey) ? indexEntry.indexKey[0] : indexEntry.indexKey;
					const cmp = compareSqlValues(keyForComparison, plan.upperBound.value);
					if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
						break;
					}
				}
				continue;
			}
			for (const pk of indexEntry.primaryKeys) {
				const value = layer.primaryTree.get(pk);
				if (value) {
					yield value as Row;
				}
			}
		}
	}
}

// LayerCursorInternal interface is removed as this file now exports an async generator.
// If TransactionLayerCursorInternal needs a common interface with this for its parentCursor,
// that interface would describe an AsyncIterable<Row> with perhaps getCurrentPrimaryKey() if still needed.
// For now, let parentCursor in TransactionLayerCursorInternal be AsyncIterable<Row>.
