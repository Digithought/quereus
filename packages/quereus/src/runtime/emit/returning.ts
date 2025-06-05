import type { ReturningNode } from '../../planner/nodes/returning-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:returning');

export function emitReturning(plan: ReturningNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for the projection source attributes
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.projectionSource.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	// Pre-emit the projection expressions
	const projectionEvaluators = plan.projections.map(proj =>
		emitCallFromPlan(proj.node, ctx)
	);

	async function* run(
		rctx: RuntimeContext,
		executorResult: any, // Result from the void executor (should be undefined if successful)
		projectionRows: AsyncIterable<Row>,
		...projectionCallbacks: Array<(ctx: RuntimeContext) => any>
	): AsyncIterable<Row> {
		// First, the executor must complete successfully
		// The executor result should be undefined for successful void operations
		// If the executor threw an error, we wouldn't reach this point

		log('Executor completed successfully, projecting RETURNING results');

		// Now project the results from the projection source
		for await (const sourceRow of projectionRows) {
			// Set up context for this row
			rctx.context.set(sourceRowDescriptor, () => sourceRow);

			try {
				const outputs = projectionCallbacks.map(func => func(rctx));
				const resolved = await Promise.all(outputs);
				// Assume we have ensured that these are all scalar values
				yield resolved as Row;
			} finally {
				// Clean up row context
				rctx.context.delete(sourceRowDescriptor);
			}
		}
	}

	// Emit the executor (void operation)
	const executorInstruction = emitPlanNode(plan.executor, ctx);

	// Emit the projection source
	const projectionSourceInstruction = emitPlanNode(plan.projectionSource, ctx);

	return {
		params: [executorInstruction, projectionSourceInstruction, ...projectionEvaluators],
		run,
		note: `returning(${plan.projections.length} cols)`
	};
}
