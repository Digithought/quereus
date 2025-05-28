import type { ScanPlan } from './scan-plan.js';
import type { BaseLayer } from './base.js';
import type { BTreeKey, BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import type { Row } from '../../../common/types.js';
import { createMutationSafeIterator } from './mutation-safe-iterator.js';

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

		// Use mutation-safe iterator for BTree iteration
		const isAscending = !plan.descending;

		// Create mutation-safe iterator with proper key extraction and comparison
		const keyExtractor = (value: Row) => keyFromEntry(value);
		const keyComparator = primaryKeyComparator;

		for await (const value of createMutationSafeIterator(
			tree,
			isAscending,
			keyExtractor,
			keyComparator
		)) {
			const row = value as Row;
			const primaryKey = keyFromEntry(row);
			if (!planAppliesToKey(primaryKey, false)) continue;
			yield row;
		}
	} else { // Secondary Index Scan
		const secondaryIndex = layer.secondaryIndexes.get(plan.indexName);
		if (!secondaryIndex) throw new Error(`Secondary index '${plan.indexName}' not found in BaseLayer.`);

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

		// Use mutation-safe iterator for secondary index iteration
		const isAscending = !plan.descending;

		// Create mutation-safe iterator for secondary index
		const indexKeyExtractor = (entry: MemoryIndexEntry) => entry.indexKey;
		const indexKeyComparator = secondaryIndex.compareKeys;

		for await (const indexEntry of createMutationSafeIterator(
			indexTree,
			isAscending,
			indexKeyExtractor,
			indexKeyComparator
		)) {
			if (!planAppliesToKey(indexEntry.indexKey, true)) continue;
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
