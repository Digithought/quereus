import type { Path } from 'digitree';
import type { ScanPlan } from './scan-plan.js';
import type { TransactionLayer } from './transaction.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, PrimaryModificationValue } from '../types.js';
import { isDeletionMarker } from '../types.js';
import type { Row } from '../../../common/types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { createLogger } from '../../../common/logger.js';
import { QuereusError } from '../../../common/errors.js';
import { MemoryIndex } from '../index.js';

const log = createLogger('vtab:memory:layer:tx-cursor');
const warnLog = log.extend('warn');

export async function* scanTransactionLayer(
	layer: TransactionLayer,
	plan: ScanPlan,
	parentIterable: AsyncIterable<Row>
): AsyncIterable<Row> {
	const tableSchema = layer.getSchema();
	const modPrimaryTree = layer.getModificationTree('primary');
	const { primaryKeyComparator, primaryKeyExtractorFromRow } = layer.getPkExtractorsAndComparators(tableSchema);

	// General plan application check (can be for PK or IndexKey)
	const planAppliesToKey = (key: BTreeKeyForPrimary | BTreeKeyForIndex, isIndexKey: boolean): boolean => {
		if (!plan) return true;
		let comparator = isIndexKey
			? layer.getSchema().indexes && new MemoryIndex({name: plan.indexName!, columns: layer.getSchema().indexes!.find(i=>i.name === plan.indexName)!.columns}, tableSchema.columns).compareKeys
			: primaryKeyComparator;

		if (!comparator && plan.indexName !== 'primary') {
			warnLog(`No comparator for index key for index ${plan.indexName}`);
			return true; // Or false, depending on strictness if comparator missing
		} else if (!comparator && plan.indexName === 'primary') {
			throw new QuereusError("Primary key comparator missing in scanTransactionLayer");
		}

		if (plan.equalityKey) {
			// Ensure types match before comparison if comparator is generic
			return comparator!(key, plan.equalityKey as any) === 0;
		}

		// For range checks on composite keys, this still simplifies to first column.
		// A full solution requires comparator to understand partial key comparisons or ScanPlan to be more detailed.
		const keyForBoundComparison = Array.isArray(key) ? key[0] : key;

		if (plan.lowerBound) {
			const cmp = compareSqlValues(keyForBoundComparison, plan.lowerBound.value); // compareSqlValues is generic
			if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
		}
		if (plan.upperBound) {
			const cmp = compareSqlValues(keyForBoundComparison, plan.upperBound.value);
			if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
		}
		return true;
	};

	if (plan.indexName !== 'primary') {
		warnLog(`scanTransactionLayer for sec index '${plan.indexName}' has complex logic. Ordering might be approximate if TX modifies index keys extensively.`);
		const secondaryIndexSchema = tableSchema.indexes?.find(i => i.name === plan.indexName);
		if (!secondaryIndexSchema) throw new QuereusError(`Secondary index ${plan.indexName} not in schema.`);

		const tempIndexForChanges = new MemoryIndex(secondaryIndexSchema, tableSchema.columns);
		const secondaryIndexChanges = layer.getSecondaryIndexChanges().get(plan.indexName) || new Map();
		const yieldedPks = new Set<string>(); // To avoid duplicates

		// 1. Process rows from parent that might still be in the index view of this TX
		const parentIterator = parentIterable[Symbol.asyncIterator]();
		let parentOp = await parentIterator.next();
		while(!parentOp.done) {
			const rowFromParent = parentOp.value;
			const pkFromParent = primaryKeyExtractorFromRow(rowFromParent);
			const serializedPk = JSON.stringify(pkFromParent);

			let effectiveRow = rowFromParent;
			let deletedInTx = false;

			const modValue = modPrimaryTree?.get(pkFromParent);
			if (modValue) {
				if (isDeletionMarker(modValue)) deletedInTx = true;
				else effectiveRow = modValue as Row;
			}

			if (deletedInTx) { parentOp = await parentIterator.next(); continue; }

			// Check if its membership in *this* secondary index was explicitly removed by this TX
			let removedFromIndexByTx = false;
			secondaryIndexChanges.forEach(change => {
				if (primaryKeyComparator(change.pk, pkFromParent) === 0 && change.op === 'DELETE' &&
					tempIndexForChanges.compareKeys(change.indexKey, tempIndexForChanges.keyFromRow(rowFromParent)) === 0) {
					removedFromIndexByTx = true;
				}
			});
			if (removedFromIndexByTx) { parentOp = await parentIterator.next(); continue; }

			// Now, does the *effectiveRow* (potentially modified) still belong in the index scan?
			const currentIndexKey = tempIndexForChanges.keyFromRow(effectiveRow);
			if (planAppliesToKey(currentIndexKey, true)) {
				if (planAppliesToKey(pkFromParent, false)) { // Check additional PK filters
					yield effectiveRow;
					yieldedPks.add(serializedPk);
				}
			}
			parentOp = await parentIterator.next();
		}

		// 2. Process rows that were effectively ADDED to this index by this transaction
		for (const change of secondaryIndexChanges.values()) {
			if (change.op === 'ADD') {
				const pkToAdd = change.pk;
				const serializedPkToAdd = JSON.stringify(pkToAdd);
				if (yieldedPks.has(serializedPkToAdd)) continue; // Already processed via parent path

				if (planAppliesToKey(change.indexKey, true)) {
					const modValue = modPrimaryTree?.get(pkToAdd);
					let rowToAdd: Row | null = null;
					if (modValue) {
						if (!isDeletionMarker(modValue)) rowToAdd = modValue as Row;
					} else {
						// This implies an update changed an existing row (from parent) to match index,
						// but the row itself wasn't otherwise modified in this TX at the PK level.
						// We need to fetch it from parent.
						// This requires ability to get specific row from parentIterable by PK, which is not straightforward.
						// For now, assume if it's an ADD to index, the row data is in primary mods or is a new insert.
						// If only index key changed for an existing row, it means it was an UPDATE.
						// The `performMutation` would have recorded an UPSERT with old/new data.
						// The primary tree mod should have the latest version.
						warnLog(`Secondary index ADD for PK ${serializedPkToAdd} but PK not in primary mods. Data might be missing for yield.`);
						// To be robust, one would need: manager.lookupEffectiveRow(pkToAdd, layer.getParent())
						// But this is complex with async iterables. This indicates a potential gap.
					}
					if (rowToAdd && planAppliesToKey(pkToAdd, false)) {
						yield rowToAdd;
					}
				}
			}
		}
		return;
	}

	// Primary Key Scan Logic (merge sort)
	let modIterator: Iterator<Path<BTreeKeyForPrimary, PrimaryModificationValue>> | undefined;
	let currentModPKey: BTreeKeyForPrimary | null = null;
	let currentModValue: PrimaryModificationValue | undefined;

	if (modPrimaryTree) {
		const rangeOptions: any = { ascending: !plan.descending };
		let useRange = false;
		if (plan.equalityKey) {
			// For EQ, we can simulate range or just do a get and then iterate if needed (though EQ usually means one)
			// Or, if digitree range supports from=X, to=X, that's an EQ scan.
			// Let's assume for now we treat EQ as a very tight range for the mod tree iterator start.
			rangeOptions.from = plan.equalityKey as BTreeKeyForPrimary;
			rangeOptions.to = plan.equalityKey as BTreeKeyForPrimary;
			useRange = true;
		} else {
			if (plan.lowerBound) {
				rangeOptions.from = plan.lowerBound.value as BTreeKeyForPrimary;
				if (plan.lowerBound.op === IndexConstraintOp.GT) rangeOptions.fromExclusive = true;
				useRange = true;
			}
			if (plan.upperBound) {
				rangeOptions.to = plan.upperBound.value as BTreeKeyForPrimary;
				if (plan.upperBound.op === IndexConstraintOp.LT) rangeOptions.toExclusive = true;
				useRange = true;
			}
		}

		if (useRange) {
			modIterator = modPrimaryTree.range(rangeOptions);
		} else {
			// Full scan of modifications if no specific range defined by plan for mods
			const startPath = plan.descending ? modPrimaryTree.last() : modPrimaryTree.first();
			if (startPath) {
				modIterator = plan.descending
					? modPrimaryTree.descending(startPath)
					: modPrimaryTree.ascending(startPath);
			}
		}

		if (modIterator) {
			const firstModResult = modIterator.next();
			if (!firstModResult.done) {
				const entry = modPrimaryTree.at(firstModResult.value);
				if (entry !== undefined) {
					currentModPKey = isDeletionMarker(entry) ? entry._key_ : primaryKeyExtractorFromRow(entry as Row);
					currentModValue = entry;
				}
			}
		} else {
			currentModPKey = null; // No relevant mods based on range
		}
	}

	const parentAsyncIterator = parentIterable[Symbol.asyncIterator]();
	let parentResult = await parentAsyncIterator.next();
	let parentPKey: BTreeKeyForPrimary | null = parentResult.done ? null : primaryKeyExtractorFromRow(parentResult.value);
	let parentRow: Row | null = parentResult.done ? null : parentResult.value;

	while (currentModPKey || parentPKey) {
		let yieldRow: Row | null = null;
		let advanceMod = false;
		let advanceParent = false;

		if (currentModPKey &&
			(!parentPKey ||
			 (plan.descending ? primaryKeyComparator(currentModPKey, parentPKey) >= 0
							  : primaryKeyComparator(currentModPKey, parentPKey) <= 0)))
		{ // Mod comes first or is equal, or parent is exhausted
			if (!isDeletionMarker(currentModValue!)) {
				if (planAppliesToKey(currentModPKey, false)) {
					yieldRow = currentModValue as Row;
				}
			}
			advanceMod = true;
			if (parentPKey && primaryKeyComparator(currentModPKey, parentPKey) === 0) {
				advanceParent = true; // Consumed corresponding parent item
			}
		} else if (parentPKey) { // Parent comes first and exists
			if (planAppliesToKey(parentPKey, false)) {
				yieldRow = parentRow;
			}
			advanceParent = true;
		} else {
			break; // Both exhausted
		}

		if (yieldRow) {
			yield yieldRow;
		}

		if (advanceMod) {
			currentModPKey = null; currentModValue = undefined;
			const nextModResult = modIterator?.next();
			if (nextModResult && !nextModResult.done && modPrimaryTree) {
				const entry = modPrimaryTree.at(nextModResult.value);
				if (entry !== undefined) {
					currentModPKey = isDeletionMarker(entry) ? entry._key_ : primaryKeyExtractorFromRow(entry as Row);
					currentModValue = entry;
				}
			}
		}
		if (advanceParent) {
			parentResult = await parentAsyncIterator.next();
			parentPKey = parentResult.done ? null : primaryKeyExtractorFromRow(parentResult.value);
			parentRow = parentResult.done ? null : parentResult.value;
		}
	}
}
