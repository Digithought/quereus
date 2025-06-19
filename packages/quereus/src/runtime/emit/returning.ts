import type { ReturningNode } from '../../planner/nodes/returning-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';

export function emitReturning(plan: ReturningNode, ctx: EmissionContext): Instruction {
	// Use the executor's attributes to build the row descriptor
	// The executor should already output the correct flat OLD/NEW format for mutation operations
	const sourceRowDescriptor = buildRowDescriptor(plan.executor.getAttributes());

	// Pre-emit the projection expressions
	const projectionEvaluators = plan.projections.map(proj =>
		emitCallFromPlan(proj.node, ctx)
	);

	async function* run(
		rctx: RuntimeContext,
		executorRows: AsyncIterable<Row>,
		...projectionCallbacks: Array<(ctx: RuntimeContext) => any>
	): AsyncIterable<Row> {
		// Project the results from the executor rows
		for await (const sourceRow of executorRows) {
			// Set up the source context - the row is already in the correct flat OLD/NEW format
			rctx.context.set(sourceRowDescriptor, () => sourceRow);

			try {
				// Evaluate projection expressions in the context of this row
				const outputs = projectionCallbacks.map(func => func(rctx));
				const resolved = await Promise.all(outputs);
				yield resolved as Row;
			} finally {
				// Clean up source context
				rctx.context.delete(sourceRowDescriptor);
			}
		}
	}

	// Emit the executor (now always produces rows)
	const executorInstruction = emitPlanNode(plan.executor, ctx);

	return {
		params: [executorInstruction, ...projectionEvaluators],
		run,
		note: `returning(${plan.projections.length} cols)`
	};
}
