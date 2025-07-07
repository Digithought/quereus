import type { FilterNode } from '../../planner/nodes/filter.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { withRowContextGenerator } from '../context-helpers.js';

export function emitFilter(plan: FilterNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const predicateFunc = emitCallFromPlan(plan.predicate, ctx);

	// Create row descriptor for source attributes
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());

	async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>, predicate: (ctx: RuntimeContext) => any): AsyncIterable<Row> {
		yield* withRowContextGenerator(ctx, sourceRowDescriptor, source, async function* (sourceRow) {
			const result = await predicate(ctx);
			if (result) {
				yield sourceRow;
			}
		});
	}

	return {
		params: [sourceInstruction, predicateFunc],
		run: run as any,
		note: `filter(${plan.predicate.toString()})`
	};
}
