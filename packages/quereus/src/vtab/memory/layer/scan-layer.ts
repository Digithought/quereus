import type { ScanPlan } from './scan-plan.js';
import type { Layer } from './interface.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { StatusCode, type Row } from '../../../common/types.js';
import { safeIterate } from './safe-iterate.js';
import { QuereusError } from '../../../common/errors.js';
import { planAppliesToKey } from './plan-filter.js';

/**
 * Scans a layer (base or transaction) according to a ScanPlan, yielding matching rows.
 * Operates on the Layer interface — the inherited BTrees handle data inheritance transparently.
 */
export async function* scanLayer(
	layer: Layer,
	plan: ScanPlan
): AsyncIterable<Row> {
	// Multi-seek: iterate over multiple equality keys
	if (plan.equalityKeys && plan.equalityKeys.length > 0) {
		for (const key of plan.equalityKeys) {
			const singlePlan: ScanPlan = { ...plan, equalityKey: key, equalityKeys: undefined };
			yield* scanLayer(layer, singlePlan);
		}
		return;
	}

	// Multi-range: iterate over multiple range specs
	if (plan.ranges && plan.ranges.length > 0) {
		for (const range of plan.ranges) {
			const singlePlan: ScanPlan = {
				...plan,
				ranges: undefined,
				lowerBound: range.lowerBound,
				upperBound: range.upperBound,
			};
			yield* scanLayer(layer, singlePlan);
		}
		return;
	}

	const schema = layer.getSchema();
	const { primaryKeyExtractorFromRow, primaryKeyComparator } = layer.getPkExtractorsAndComparators(schema);

	if (plan.indexName === 'primary') {
		const tree = layer.getModificationTree('primary');
		if (!tree) return;

		if (plan.equalityKey != null) {
			const value = tree.get(plan.equalityKey as BTreeKeyForPrimary);
			if (value) {
				yield value as Row;
			}
			return;
		}

		// Determine start key for range scans
		let startKey: { value: BTreeKeyForPrimary } | undefined;
		if (plan.equalityPrefix) {
			const compositeStart = [...plan.equalityPrefix];
			if (plan.lowerBound) compositeStart.push(plan.lowerBound.value);
			startKey = { value: compositeStart as BTreeKeyForPrimary };
		} else if (plan.lowerBound) {
			startKey = { value: plan.lowerBound.value as BTreeKeyForPrimary };
		}

		for await (const value of safeIterate(tree, !plan.descending, startKey)) {
			const row = value as Row;
			const primaryKey = primaryKeyExtractorFromRow(row);
			if (!planAppliesToKey(plan, primaryKey, primaryKeyComparator)) {
				// Early termination for prefix-range: break when prefix no longer matches
				if (plan.equalityPrefix) {
					const keyArr = Array.isArray(primaryKey) ? primaryKey : [primaryKey];
					let prefixMismatch = false;
					for (let i = 0; i < plan.equalityPrefix.length; i++) {
						if (compareSqlValues(keyArr[i], plan.equalityPrefix[i]) !== 0) {
							prefixMismatch = true;
							break;
						}
					}
					if (prefixMismatch) break;
				}
				// Ascending scan past upper bound — early exit
				if (!plan.descending && plan.upperBound && !plan.equalityPrefix) {
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
	} else {
		// Secondary Index Scan
		const indexTree = layer.getSecondaryIndexTree(plan.indexName);
		if (!indexTree) throw new QuereusError(`Secondary index '${plan.indexName}' not found.`, StatusCode.INTERNAL);

		const primaryTree = layer.getModificationTree('primary');

		if (plan.equalityKey != null) {
			const indexEntry = indexTree.get(plan.equalityKey as BTreeKeyForIndex);
			if (indexEntry && primaryTree) {
				for (const pk of indexEntry.primaryKeys) {
					const value = primaryTree.get(pk);
					if (value) {
						yield value as Row;
					}
				}
			}
			return;
		}

		const isAscending = !plan.descending;
		const indexDef = schema.indexes?.find(idx => idx.name === plan.indexName);
		const isDescFirstColumn = indexDef?.columns[0]?.desc === true;

		// Determine start key
		let startKey: { value: BTreeKeyForIndex } | undefined;
		if (plan.equalityPrefix) {
			const compositeStart = [...plan.equalityPrefix];
			if (plan.lowerBound) compositeStart.push(plan.lowerBound.value);
			startKey = { value: compositeStart as BTreeKeyForIndex };
		} else if (isDescFirstColumn) {
			if (plan.upperBound) {
				startKey = { value: plan.upperBound.value as BTreeKeyForIndex };
			}
		} else {
			if (plan.lowerBound) {
				startKey = { value: plan.lowerBound.value as BTreeKeyForIndex };
			}
		}

		for await (const indexEntry of safeIterate(indexTree, isAscending, startKey)) {
			if (!planAppliesToKey(plan, indexEntry.indexKey, primaryKeyComparator)) {
				// Early termination for prefix-range: break when prefix no longer matches
				if (plan.equalityPrefix) {
					const keyArr = Array.isArray(indexEntry.indexKey) ? indexEntry.indexKey : [indexEntry.indexKey];
					let prefixMismatch = false;
					for (let i = 0; i < plan.equalityPrefix.length; i++) {
						if (compareSqlValues(keyArr[i], plan.equalityPrefix[i]) !== 0) {
							prefixMismatch = true;
							break;
						}
					}
					if (prefixMismatch) break;
					continue;
				}
				// Early termination: for ASC indexes break when past the relevant bound
				if (isAscending) {
					if (isDescFirstColumn && plan.lowerBound) {
						const keyForComparison = Array.isArray(indexEntry.indexKey) ? indexEntry.indexKey[0] : indexEntry.indexKey;
						const cmp = compareSqlValues(keyForComparison, plan.lowerBound.value);
						if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) {
							break;
						}
					} else if (!isDescFirstColumn && plan.upperBound) {
						const keyForComparison = Array.isArray(indexEntry.indexKey) ? indexEntry.indexKey[0] : indexEntry.indexKey;
						const cmp = compareSqlValues(keyForComparison, plan.upperBound.value);
						if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
							break;
						}
					}
				}
				continue;
			}
			if (!primaryTree) continue;
			for (const pk of indexEntry.primaryKeys) {
				const value = primaryTree.get(pk);
				if (value) {
					yield value as Row;
				}
			}
		}
	}
}
