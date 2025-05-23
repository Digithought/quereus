import type { BTree, Path } from 'digitree';
import type { ScanPlan } from './scan-plan.js';
import type { BaseLayer } from './base.js';
import type { BTreeKey, BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import type { Row, SqlValue } from '../../../common/types.js';
import { createLogger } from '../../../common/logger.js';

const log = createLogger('vtab:memory:layer:base-cursor');
// const warnLog = log.extend('warn');
// const errorLog = log.extend('error');

// This will now be an async generator function rather than a class
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
		const tree = layer.primaryTree; // BTree<BTreeKeyForPrimary, Row>

		if (isEqPlan && plan.equalityKey !== undefined) {
			const row = tree.get(plan.equalityKey as BTreeKeyForPrimary);
			if (row && planAppliesToKey(plan.equalityKey as BTreeKeyForPrimary, false)) {
				yield row;
			}
			return;
		}

		const rangeOptions: any = { ascending: !plan.descending };
		if (plan.lowerBound) {
			rangeOptions.from = plan.lowerBound.value as BTreeKeyForPrimary;
			if (plan.lowerBound.op === IndexConstraintOp.GT) rangeOptions.fromExclusive = true;
		}
		if (plan.upperBound) {
			rangeOptions.to = plan.upperBound.value as BTreeKeyForPrimary;
			if (plan.upperBound.op === IndexConstraintOp.LT) rangeOptions.toExclusive = true;
		}

		const iterator = tree.range(rangeOptions);

		for (const path of iterator) {
			const row = tree.at(path);
			if (!row) continue;
			const primaryKey = keyFromEntry(row);
			if (!planAppliesToKey(primaryKey, false)) continue;
			yield row;
		}
	} else { // Secondary Index Scan
		const secondaryIndex = layer.secondaryIndexes.get(plan.indexName);
		if (!secondaryIndex) throw new Error(`Secondary index '${plan.indexName}' not found in BaseLayer.`);

		const indexTree = secondaryIndex.data; // BTree<BTreeKeyForIndex, MemoryIndexEntry>

		if (isEqPlan && plan.equalityKey !== undefined) {
			const indexEntry = indexTree.get(plan.equalityKey as BTreeKeyForIndex);
			if (indexEntry && planAppliesToKey(indexEntry.indexKey, true)) { // Check if the index key itself is valid by plan
				for (const pk of indexEntry.primaryKeys) {
					const row = layer.primaryTree.get(pk);
					if (row) yield row;
				}
			}
			return;
		}

		const rangeOptions: any = { ascending: !plan.descending };
		if (plan.lowerBound) {
			rangeOptions.from = plan.lowerBound.value as BTreeKeyForIndex;
			if (plan.lowerBound.op === IndexConstraintOp.GT) rangeOptions.fromExclusive = true;
		}
		if (plan.upperBound) {
			rangeOptions.to = plan.upperBound.value as BTreeKeyForIndex;
			if (plan.upperBound.op === IndexConstraintOp.LT) rangeOptions.toExclusive = true;
		}

		const iterator = indexTree.range(rangeOptions);

		for (const path of iterator) {
			const indexEntry = indexTree.at(path);
			if (!indexEntry) continue;
			if (!planAppliesToKey(indexEntry.indexKey, true)) continue;
			for (const pk of indexEntry.primaryKeys) {
				const row = layer.primaryTree.get(pk);
				if (row) {
					// TODO: Apply remaining ScanPlan constraints to this `row` (those not on the index key)
					yield row;
				}
			}
		}
	}
}

// LayerCursorInternal interface is removed as this file now exports an async generator.
// If TransactionLayerCursorInternal needs a common interface with this for its parentCursor,
// that interface would describe an AsyncIterable<Row> with perhaps getCurrentPrimaryKey() if still needed.
// For now, let parentCursor in TransactionLayerCursorInternal be AsyncIterable<Row>.
