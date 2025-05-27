import type { FilterNode } from '../../planner/nodes/filter.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCall, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { isTruthy } from '../../util/comparison.js';

export function emitFilter(plan: FilterNode, ctx: EmissionContext): Instruction {
	async function* run(ctx: RuntimeContext, sourceRows: AsyncIterable<Row>, predicate: (ctx: RuntimeContext) => SqlValue): AsyncIterable<Row> {
		for await (const sourceRow of sourceRows) {
			// Set up context for this row - the source relation should be available for column references
			ctx.context.set(plan.source, () => sourceRow);
			try {
				if (isTruthy(predicate(ctx))) {
					yield sourceRow;
				}
			} finally {
				// Clean up context for this row
				ctx.context.delete(plan.source);
			}
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const predicateFunc = emitCallFromPlan(plan.predicate, ctx);

	return {
		params: [sourceInstruction, predicateFunc],
		run: run as any,
		note: `filter(predicate)`
	};
}
