import type { BloomJoinNode } from '../../planner/nodes/bloom-join-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row, OutputValue, SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';

const log = createLogger('runtime:emit:bloom-join');

/**
 * Serialize a composite key from a row for hash-map lookup.
 * Type-tagged to avoid collisions (e.g., '1' vs 1).
 * Null is handled distinctly — null != null in SQL, so null keys never match.
 */
function serializeKey(row: Row, indices: readonly number[]): string | null {
	let key = '';
	for (let i = 0; i < indices.length; i++) {
		const val = row[indices[i]];
		if (val === null || val === undefined) return null; // null never matches
		if (i > 0) key += '\0';
		if (typeof val === 'string') {
			key += 's:' + val;
		} else if (typeof val === 'number') {
			key += 'n:' + val;
		} else if (typeof val === 'bigint') {
			key += 'b:' + val;
		} else if (val instanceof Uint8Array) {
			key += 'x:' + Array.from(val).join(',');
		} else {
			key += 'o:' + String(val);
		}
	}
	return key;
}

/**
 * Emits a bloom (hash) join instruction.
 *
 * Build phase: materializes the right (build) side into a Map keyed by
 * serialized equi-join column values.
 * Probe phase: streams the left (probe) side, probing the map for matches.
 */
export function emitBloomJoin(plan: BloomJoinNode, ctx: EmissionContext): Instruction {
	const leftAttributes = plan.left.getAttributes();
	const rightAttributes = plan.right.getAttributes();

	const leftRowDescriptor = buildRowDescriptor(leftAttributes);
	const rightRowDescriptor = buildRowDescriptor(rightAttributes);

	// Pre-resolve equi-pair column indices from attribute IDs
	const leftIndices: number[] = [];
	const rightIndices: number[] = [];
	for (const pair of plan.equiPairs) {
		const li = leftAttributes.findIndex(a => a.id === pair.leftAttrId);
		const ri = rightAttributes.findIndex(a => a.id === pair.rightAttrId);
		if (li === -1 || ri === -1) {
			throw new Error(`BloomJoin: could not resolve equi-pair attr IDs ${pair.leftAttrId}=${pair.rightAttrId}`);
		}
		leftIndices.push(li);
		rightIndices.push(ri);
	}

	const rightColCount = rightAttributes.length;

	async function* run(
		rctx: RuntimeContext,
		leftSource: AsyncIterable<Row>,
		rightSource: AsyncIterable<Row>,
		residualCallback?: (ctx: RuntimeContext) => OutputValue
	): AsyncIterable<Row> {
		log('Starting %s hash join: %d equi-pairs, %d left attrs, %d right attrs',
			plan.joinType.toUpperCase(), plan.equiPairs.length, leftAttributes.length, rightAttributes.length);

		// === Build phase: materialize right side into hash map ===
		const hashMap = new Map<string, Row[]>();
		for await (const rightRow of rightSource) {
			const key = serializeKey(rightRow, rightIndices);
			if (key === null) continue; // null keys can't match
			const bucket = hashMap.get(key);
			if (bucket) {
				bucket.push(rightRow);
			} else {
				hashMap.set(key, [rightRow]);
			}
		}

		log('Build phase complete: %d buckets, right side materialized', hashMap.size);

		// === Probe phase: stream left side, probe hash map ===
		const leftSlot = createRowSlot(rctx, leftRowDescriptor);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor);

		try {
			for await (const leftRow of leftSource) {
				leftSlot.set(leftRow);

				const key = serializeKey(leftRow, leftIndices);
				let matched = false;

				if (key !== null) {
					const bucket = hashMap.get(key);
					if (bucket) {
						for (const rightRow of bucket) {
							rightSlot.set(rightRow);

							// Evaluate residual condition if present
							if (residualCallback) {
								const result = await residualCallback(rctx);
								if (!result) continue;
							}

							matched = true;
							yield [...leftRow, ...rightRow] as Row;
						}
					}
				}

				// LEFT JOIN: emit null-padded row for unmatched probe rows
				if (!matched && plan.joinType === 'left') {
					const nullPadding = new Array(rightColCount).fill(null) as Row;
					rightSlot.set(nullPadding);
					yield [...leftRow, ...nullPadding] as Row;
				}
			}
		} finally {
			leftSlot.close();
			rightSlot.close();
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitPlanNode(plan.right, ctx);

	const params = [leftInstruction, rightInstruction];
	if (plan.residualCondition) {
		const residualInstruction = emitCallFromPlan(plan.residualCondition, ctx);
		params.push(residualInstruction);
	}

	return {
		params,
		run: run as InstructionRun,
		note: `${plan.joinType} join (bloom/hash)`
	};
}
