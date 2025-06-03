import type { ProjectNode } from '../../planner/nodes/project-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row } from '../../common/types.js';
import { type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitProject(plan: ProjectNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const projectionFuncs = plan.projections.map((projection, index) => {
		return emitCallFromPlan(projection.node, ctx);
	});

	// Create row descriptor for source attributes
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>, ...projectionFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		for await (const sourceRow of source) {
			// Set up context for this row using row descriptor
			ctx.context.set(sourceRowDescriptor, () => sourceRow);

			try {
				const outputs = projectionFunctions.map(func => func(ctx));
				const resolved = await Promise.all(outputs);
				// Assume we have ensured that these are all scalar values
				yield resolved as Row;
			} finally {
				// Clean up context for this row
				ctx.context.delete(sourceRowDescriptor);
			}
		}
	}

	return {
		params: [sourceInstruction, ...projectionFuncs],
		run: run as any,
		note: `project(${plan.projections.length} cols)`
	};
}
