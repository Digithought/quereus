import type { ProjectNode } from '../../planner/nodes/project-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row } from '../../common/types.js';
import { type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { withAsyncRowContext, withRowContextGenerator } from '../context-helpers.js';

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
			// Evaluate projections using the source row context
			const outputs = await withAsyncRowContext(rctx, sourceRowDescriptor, () => sourceRow, async () => {
				return Promise.all(projectionFunctions.map(fn => fn(rctx)));
			});

			// Push the output row descriptor for downstream consumers
			yield* withRowContextGenerator(
				rctx,
				outputRowDescriptor,
				(async function* () {
					yield outputs as Row;
				})(),
				async function* (row) {
					yield row;
				}
			);
		}
	}

	return {
		params: [sourceInstruction, ...projectionFuncs],
		run: run as InstructionRun,
		note: `project(${plan.projections.length} cols)`
	};
}
