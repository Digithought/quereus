import type { ReturningNode } from '../../planner/nodes/returning-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';

const log = createLogger('runtime:emit:returning');

export function emitReturning(plan: ReturningNode, ctx: EmissionContext): Instruction {
	// Find row descriptor from the executor
	let rowDescriptor: RowDescriptor = [];

	// Try to get row descriptor from various sources
	const executor = plan.executor as any;
	if (executor.newRowDescriptor && Object.keys(executor.newRowDescriptor).length > 0) {
		rowDescriptor = executor.newRowDescriptor;
	} else if (executor.source?.newRowDescriptor && Object.keys(executor.source.newRowDescriptor).length > 0) {
		rowDescriptor = executor.source.newRowDescriptor;
	} else if (executor.oldRowDescriptor && Object.keys(executor.oldRowDescriptor).length > 0) {
		rowDescriptor = executor.oldRowDescriptor;
	} else {
		// Fallback: create row descriptor from executor attributes
		rowDescriptor = buildRowDescriptor(plan.executor.getAttributes());
	}

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
			// Set up context for this row
			rctx.context.set(rowDescriptor, () => sourceRow);
			try {
				const outputs = projectionCallbacks.map(func => func(rctx));
				const resolved = await Promise.all(outputs);
				yield resolved as Row;
			} finally {
				// Clean up row context
				rctx.context.delete(rowDescriptor);
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
