import type { AsofScanNode } from '../../planner/nodes/asof-scan-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { compareSqlValuesFast, BINARY_COLLATION } from '../../util/comparison.js';
import type { CollationFunction } from '../../util/comparison.js';
import { resolveKeyNormalizer, serializeRowKey } from '../../util/key-serializer.js';
import { joinOutputRow } from './join-output.js';

const log = createLogger('runtime:emit:asof-scan');

/**
 * Emits an asof scan instruction.
 *
 * Algorithm (hash-bucketed):
 * 1. Bucket the right input by partition key (single bucket if no partition).
 *    Within each bucket, rows arrive in monotonicOn(matchAttr, asc) order from
 *    the right access plan. Right rows with NULL match values are dropped.
 * 2. For each left row:
 *    - Look up its partition's bucket. If absent, emit NULL-padded (outer) or
 *      drop (inner).
 *    - 'desc' direction (latest right ≤ left.match): cursor starts at -1 and
 *      advances forward while the next bucket row's match still qualifies
 *      (≤ left.match, or < when strict). The cursor sits on the last
 *      qualifying row.
 *    - 'asc' direction (earliest right ≥ left.match): cursor starts at 0 and
 *      advances forward while the current bucket row's match is too small
 *      (< left.match, or ≤ when strict). The cursor sits on the first
 *      qualifying row, or past-the-end when no row qualifies.
 *    - Emit (left, projected right) when the cursor lands on a match;
 *      otherwise NULL-pad (outer) or drop (inner).
 * 3. Left rows with NULL match values are NULL-padded (outer) or dropped.
 */
export function emitAsofScan(plan: AsofScanNode, ctx: EmissionContext): Instruction {
	const leftAttrs = plan.left.getAttributes();
	const rightAttrs = plan.right.getAttributes();

	const leftRowDescriptor = buildRowDescriptor(leftAttrs);
	const rightRowDescriptor = buildRowDescriptor(rightAttrs);

	const leftMatchIdx = leftAttrs.findIndex(a => a.id === plan.matchAttr.leftAttrId);
	const rightMatchIdx = rightAttrs.findIndex(a => a.id === plan.matchAttr.rightAttrId);
	if (leftMatchIdx === -1 || rightMatchIdx === -1) {
		throw new Error(`AsofScan: could not resolve match-attr ids ${plan.matchAttr.leftAttrId}/${plan.matchAttr.rightAttrId}`);
	}
	const matchCollationName = leftAttrs[leftMatchIdx].type.collationName ?? rightAttrs[rightMatchIdx].type.collationName;
	const matchCollation: CollationFunction = matchCollationName ? ctx.resolveCollation(matchCollationName) : BINARY_COLLATION;

	const leftPartitionIndices: number[] = [];
	const rightPartitionIndices: number[] = [];
	const keyNormalizers: ((s: string) => string)[] = [];
	for (const p of plan.partitionAttrs) {
		const leftIdx = leftAttrs.findIndex(a => a.id === p.leftAttrId);
		const rightIdx = rightAttrs.findIndex(a => a.id === p.rightAttrId);
		if (leftIdx === -1 || rightIdx === -1) {
			throw new Error(`AsofScan: could not resolve partition-attr ids ${p.leftAttrId}/${p.rightAttrId}`);
		}
		leftPartitionIndices.push(leftIdx);
		rightPartitionIndices.push(rightIdx);
		const collationName = leftAttrs[leftIdx].type.collationName ?? rightAttrs[rightIdx].type.collationName;
		keyNormalizers.push(resolveKeyNormalizer(collationName));
	}

	const rightOutputColumnIndices = plan.getRightOutputColumnIndices();
	const projectedRightColCount = rightOutputColumnIndices.length;
	const outerJoinType: 'left' | 'inner' = plan.outer ? 'left' : 'inner';
	const strict = plan.strict;
	const direction = plan.direction;

	function projectRight(row: Row): Row {
		const out: Row = new Array(projectedRightColCount);
		for (let i = 0; i < projectedRightColCount; i++) {
			out[i] = row[rightOutputColumnIndices[i]];
		}
		return out;
	}

	async function* run(
		rctx: RuntimeContext,
		leftSource: AsyncIterable<Row>,
		rightSource: AsyncIterable<Row>,
	): AsyncIterable<Row> {
		log('Starting %s asof scan: direction=%s, %d partition keys, strict=%s',
			plan.outer ? 'LEFT' : 'INNER', direction, plan.partitionAttrs.length, strict);

		const leftSlot = createRowSlot(rctx, leftRowDescriptor);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor);

		try {
			// Bucket right rows by partition key. Right rows with NULL match are dropped;
			// those with NULL partition values are dropped (sentinel null key).
			const buckets = new Map<string, Row[]>();
			let rightCount = 0;
			for await (const row of rightSource) {
				if (row[rightMatchIdx] === null) continue;
				const pk = serializeRowKey(row, rightPartitionIndices, keyNormalizers);
				if (pk === null) continue; // NULL partition value — never matches
				let bucket = buckets.get(pk);
				if (!bucket) {
					bucket = [];
					buckets.set(pk, bucket);
				}
				bucket.push(row);
				rightCount++;
			}
			log('Right side bucketed: %d rows in %d buckets', rightCount, buckets.size);

			// Per-bucket cursor positions (the index of the latest row whose match ≤ current left.match).
			// -1 means "before the first row" (no match yet).
			const cursors = new Map<string, number>();

			for await (const leftRow of leftSource) {
				leftSlot.set(leftRow);

				const leftMatch = leftRow[leftMatchIdx];
				if (leftMatch === null) {
					// Left match is NULL — three-valued logic excludes it from any match.
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					continue;
				}

				const pk = serializeRowKey(leftRow, leftPartitionIndices, keyNormalizers);
				if (pk === null) {
					// NULL partition value — bucket can't be matched.
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					continue;
				}

				const bucket = buckets.get(pk);
				if (!bucket || bucket.length === 0) {
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					continue;
				}

				const initialCursor = direction === 'desc' ? -1 : 0;
				let cursor = cursors.get(pk) ?? initialCursor;
				let matchedRight: Row | undefined;

				if (direction === 'desc') {
					// Cursor is the index of the last qualifying row (or -1 before any).
					// Advance while bucket[cursor+1].match still qualifies (≤ left.match, or <).
					while (cursor + 1 < bucket.length) {
						const candidate = bucket[cursor + 1];
						const cmp = compareSqlValuesFast(candidate[rightMatchIdx], leftMatch, matchCollation);
						if (strict ? cmp < 0 : cmp <= 0) cursor++;
						else break;
					}
					cursors.set(pk, cursor);
					if (cursor >= 0) matchedRight = bucket[cursor];
				} else {
					// 'asc': cursor is the index of the first qualifying row (or bucket.length when none).
					// Advance while bucket[cursor].match is still too small (< left.match, or ≤).
					while (cursor < bucket.length) {
						const candidate = bucket[cursor];
						const cmp = compareSqlValuesFast(candidate[rightMatchIdx], leftMatch, matchCollation);
						if (strict ? cmp <= 0 : cmp < 0) cursor++;
						else break;
					}
					cursors.set(pk, cursor);
					if (cursor < bucket.length) matchedRight = bucket[cursor];
				}

				if (!matchedRight) {
					// No row in this bucket qualifies for the current left.match.
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					continue;
				}
				rightSlot.set(matchedRight);

				const projectedRight = projectRight(matchedRight);
				yield [...leftRow, ...projectedRight] as Row;
			}
		} finally {
			leftSlot.close();
			rightSlot.close();
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitPlanNode(plan.right, ctx);

	return {
		params: [leftInstruction, rightInstruction],
		run: run as InstructionRun,
		note: `${plan.outer ? 'left' : 'inner'} asof scan${strict ? ' strict' : ''}`,
	};
}
