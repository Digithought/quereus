import type { ScanPlan } from './scan-plan.js';
import type { TransactionLayer } from './transaction.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex } from '../types.js';
import type { Row } from '../../../common/types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { QuereusError } from '../../../common/errors.js';
import { safeIterate } from './safe-iterate.js';

export async function* scanTransactionLayer(
	layer: TransactionLayer,
	plan: ScanPlan,
	_parentIterable: AsyncIterable<Row>
): AsyncIterable<Row> {
	const tableSchema = layer.getSchema();

	// General plan application check
	const planAppliesToKey = (key: BTreeKeyForPrimary | BTreeKeyForIndex, isIndexKey: boolean): boolean => {
		if (!plan) return true;

		// For index keys, we need the comparator for that specific index
		let comparator;
		if (isIndexKey && plan.indexName !== 'primary') {
			// We can get the comparator from the MemoryIndex, but this is simplified for now
			// In practice, we'd need access to the MemoryIndex's compareKeys method
			comparator = (a: any, b: any) => compareSqlValues(a, b); // Simplified
		} else {
			const { primaryKeyComparator } = layer.getPkExtractorsAndComparators(tableSchema);
			comparator = primaryKeyComparator;
		}

		if (plan.equalityKey) {
			return comparator(key, plan.equalityKey as any) === 0;
		}

		// For range checks on composite keys, this still simplifies to first column.
		const keyForBoundComparison = Array.isArray(key) ? key[0] : key;

		if (plan.lowerBound) {
			const cmp = compareSqlValues(keyForBoundComparison, plan.lowerBound.value);
			if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
		}
		if (plan.upperBound) {
			const cmp = compareSqlValues(keyForBoundComparison, plan.upperBound.value);
			if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
		}
		return true;
	};

	if (plan.indexName === 'primary') {
		// Primary key scan - much simpler with inherited BTrees
		const primaryTree = layer.getModificationTree('primary');
		if (!primaryTree) return;

		const { primaryKeyExtractorFromRow } = layer.getPkExtractorsAndComparators(tableSchema);

		// Use proper Inheritree API for iteration
		const isAscending = !plan.descending;

		if (plan.equalityKey) {
			// For equality scans, just get the specific value
			const value = primaryTree.get(plan.equalityKey as BTreeKeyForPrimary);
			if (value) {
				const row = value as Row;
				const primaryKey = primaryKeyExtractorFromRow(row);
				if (planAppliesToKey(primaryKey, false)) {
					yield row;
				}
			}
		} else {
			// Determine start key for range scans
			let startKey: { value: BTreeKeyForPrimary } | undefined;
			if (plan.lowerBound) {
				startKey = { value: plan.lowerBound.value as BTreeKeyForPrimary };
			}

			// Use mutation-safe iterator for full scans or range scans with range support
			for await (const value of safeIterate(primaryTree, isAscending, startKey)) {
				// With inheritree, deleted entries simply don't appear in iteration
				// No need to check for deletion markers

				const row = value as Row;
				const primaryKey = primaryKeyExtractorFromRow(row);

				// Apply plan filters
				if (planAppliesToKey(primaryKey, false)) {
					yield row;
				} else {
					// Early termination for ascending scans past upper bound
					if (isAscending && plan.upperBound) {
						const keyForComparison = Array.isArray(primaryKey) ? primaryKey[0] : primaryKey;
						const cmp = compareSqlValues(keyForComparison, plan.upperBound.value);
						if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
							break;
						}
					}
				}
			}
		}
	} else {
		// Secondary index scan - also simplified with inherited BTrees
		const secondaryTree = layer.getSecondaryIndexTree(plan.indexName);
		if (!secondaryTree) {
			throw new QuereusError(`Secondary index ${plan.indexName} not found in TransactionLayer.`);
		}

		// Use proper Inheritree API for secondary index iteration
		const isAscending = !plan.descending;

		if (plan.equalityKey) {
			// For equality scans on secondary index
			const indexEntry = secondaryTree.get(plan.equalityKey as BTreeKeyForIndex);
			if (indexEntry && planAppliesToKey(indexEntry.indexKey, true)) {
				// Get the primary tree to fetch actual rows
				const primaryTree = layer.getModificationTree('primary');
				if (primaryTree) {
					for (const pk of indexEntry.primaryKeys) {
						const value = primaryTree.get(pk);
						if (value) {
							const row = value as Row;
							yield row;
						}
					}
				}
			}
		} else {
			// Determine start key for range scans on secondary index
			let startKey: { value: BTreeKeyForIndex } | undefined;
			if (plan.lowerBound) {
				startKey = { value: plan.lowerBound.value as BTreeKeyForIndex };
			}

			// Use mutation-safe iterator for full scans or range scans on secondary index with range support
			for await (const indexEntry of safeIterate(secondaryTree, isAscending, startKey)) {
				// Apply plan filters to the index key
				if (planAppliesToKey(indexEntry.indexKey, true)) {
					// Get the primary tree to fetch actual rows
					const primaryTree = layer.getModificationTree('primary');
					if (!primaryTree) continue;

					// For each primary key in this index entry, fetch the row
					for (const pk of indexEntry.primaryKeys) {
						const value = primaryTree.get(pk);
						if (value) {
							const row = value as Row;
							yield row;
						}
					}
				} else {
					// Early termination for ascending scans past upper bound
					if (isAscending && plan.upperBound) {
						const keyForComparison = Array.isArray(indexEntry.indexKey) ? indexEntry.indexKey[0] : indexEntry.indexKey;
						const cmp = compareSqlValues(keyForComparison, plan.upperBound.value);
						if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
							break;
						}
					}
				}
			}
		}
	}
}
