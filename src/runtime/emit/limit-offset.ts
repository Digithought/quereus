import type { LimitOffsetNode } from '../../planner/nodes/limit-offset.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitLimitOffset(plan: LimitOffsetNode, ctx: EmissionContext): Instruction {
	async function* run(
		ctx: RuntimeContext,
		sourceRows: AsyncIterable<Row>,
		limitValue: SqlValue,
		offsetValue: SqlValue
	): AsyncIterable<Row> {

		// Convert to numbers, handling null/undefined
		const limit = limitValue !== null ? Number(limitValue) : Infinity;
		const offset = offsetValue !== null ? Number(offsetValue) : 0;

		// Validate values
		if (isNaN(limit) || limit < 0) {
			throw new Error(`Invalid LIMIT value: ${limitValue}`);
		}
		if (isNaN(offset) || offset < 0) {
			throw new Error(`Invalid OFFSET value: ${offsetValue}`);
		}

		let rowCount = 0;
		let yieldedCount = 0;

		for await (const row of sourceRows) {
			// Skip rows for OFFSET
			if (rowCount < offset) {
				rowCount++;
				continue;
			}

			// Stop if we've yielded enough rows for LIMIT
			if (yieldedCount >= limit) {
				break;
			}

			yield row;
			rowCount++;
			yieldedCount++;
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Add limit and offset functions if they exist, otherwise literal nulls
	const limit = emitPlanNode(plan.limit, ctx);
	const offset = emitPlanNode(plan.offset, ctx);

	return {
		params: [sourceInstruction, limit, offset],
		run: run as any,
		note: `limit_offset`
	};
}
