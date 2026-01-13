import type { Row, SqlValue } from '@quereus/quereus';
import type { MergeEntry, MergeConfig } from './merge-types.js';

/**
 * Merges two sorted streams (overlay and underlying) into a single sorted stream.
 *
 * Overlay entries take precedence:
 * - Insert/Update entries replace any underlying row with the same PK
 * - Tombstone entries cause the underlying row to be skipped
 *
 * Both input streams MUST be sorted by the same key (PK for primary scans,
 * index key for secondary index scans). The output stream maintains this ordering.
 *
 * For secondary index scans:
 * - Both streams are ordered by (indexKey, PK)
 * - The merge compares by sort key for ordering
 * - When PKs match, overlay precedence is applied
 *
 * @param overlay Stream of overlay entries (inserts, updates, tombstones)
 * @param underlying Stream of committed rows from underlying storage
 * @param config Comparison and extraction functions
 * @returns Merged stream of rows
 */
export async function* mergeStreams(
	overlay: AsyncIterable<MergeEntry>,
	underlying: AsyncIterable<Row>,
	config: MergeConfig
): AsyncGenerator<Row> {
	const { comparePK, extractPK } = config;
	// Use sort key functions if provided, otherwise fall back to PK functions
	const compareSortKey = config.compareSortKey ?? comparePK;
	const extractSortKey = config.extractSortKey ?? extractPK;

	const overlayIter = overlay[Symbol.asyncIterator]();
	const underlyingIter = underlying[Symbol.asyncIterator]();

	let overlayNext = await overlayIter.next();
	let underlyingNext = await underlyingIter.next();

	try {
		while (!overlayNext.done || !underlyingNext.done) {
			if (overlayNext.done) {
				// Only underlying has elements
				yield underlyingNext.value;
				underlyingNext = await underlyingIter.next();
			} else if (underlyingNext.done) {
				// Only overlay has elements
				if (!overlayNext.value.tombstone) {
					yield overlayNext.value.row;
				}
				overlayNext = await overlayIter.next();
			} else {
				// Both have elements - compare by sort key
				const overlayEntry = overlayNext.value;
				const underlyingRow = underlyingNext.value;
				const underlyingSortKey = extractSortKey(underlyingRow);

				const cmp = compareSortKey(overlayEntry.sortKey, underlyingSortKey);

				if (cmp < 0) {
					// Overlay sort key comes first
					if (!overlayEntry.tombstone) {
						yield overlayEntry.row;
					}
					overlayNext = await overlayIter.next();
				} else if (cmp > 0) {
					// Underlying sort key comes first
					yield underlyingRow;
					underlyingNext = await underlyingIter.next();
				} else {
					// Same sort key means same PK (sort key includes PK as tiebreaker)
					// Overlay wins
					if (!overlayEntry.tombstone) {
						yield overlayEntry.row;
					}
					// Skip underlying, advance both
					overlayNext = await overlayIter.next();
					underlyingNext = await underlyingIter.next();
				}
			}
		}
	} finally {
		// Cleanup iterators if they have return methods
		await overlayIter.return?.();
		await underlyingIter.return?.();
	}
}

/**
 * Creates a merge entry for an insert or update.
 * @param row The row data
 * @param pk The primary key values
 * @param sortKey The sort key values (defaults to pk if not provided)
 */
export function createMergeEntry(row: Row, pk: SqlValue[], sortKey?: SqlValue[]): MergeEntry {
	return { row, pk, tombstone: false, sortKey: sortKey ?? pk };
}

/**
 * Creates a tombstone merge entry for a delete.
 * @param pk The primary key values
 * @param sortKey The sort key values (defaults to pk if not provided)
 */
export function createTombstone(pk: SqlValue[], sortKey?: SqlValue[]): MergeEntry {
	return { row: pk, pk, tombstone: true, sortKey: sortKey ?? pk };
}
