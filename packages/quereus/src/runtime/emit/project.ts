import type { ProjectNode } from '../../planner/nodes/project-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row } from '../../common/types.js';
import { type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { withAsyncRowContext } from '../context-helpers.js';

export function emitProject(plan: ProjectNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const projectionFuncs = plan.projections.map((projection) => {
		return emitCallFromPlan(projection.node, ctx);
	});

	// Row descriptors
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

	async function* run(rctx: RuntimeContext, source: AsyncIterable<Row>, ...projectionFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		for await (const sourceRow of source) {
			// Evaluate projections in source context only
			const resolved = await withAsyncRowContext(rctx, sourceRowDescriptor, () => sourceRow, async () => {
				const outputs = projectionFunctions.map(func => func(rctx));
				return await Promise.all(outputs);
			});

			// Yield the result row directly - downstream operators will push their own contexts as needed
			yield resolved as Row;
		}
	}

	return {
		params: [sourceInstruction, ...projectionFuncs],
		run: run as any,
		note: `project(${plan.projections.length} cols)`
	};
}
