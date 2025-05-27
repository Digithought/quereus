import type { ProjectNode } from '../../planner/nodes/project-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row } from '../../common/types.js';
import { type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitProject(plan: ProjectNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const projectionFuncs = plan.projections.map(projection => emitCallFromPlan(projection.node, ctx));

	async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>, ...projectionFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		for await (const sourceRow of source) {
			// Set up context for this row - the source relation should be available for column references
			ctx.context.set(plan.source, () => sourceRow);

			try {
				const outputs = projectionFunctions.map(func => func(ctx));
				const resolved = await Promise.all(outputs);
				// Assume we have ensured that these are all scalar values
				yield resolved as Row;
			} finally {
				// Clean up context for this row
				ctx.context.delete(plan.source);
			}
		}
	}

	return {
		params: [sourceInstruction, ...projectionFuncs],
		run: run as any,
		note: `project(${plan.projections.length} cols)`
	};
}
