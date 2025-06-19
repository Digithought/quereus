import type { DeleteNode } from '../../planner/nodes/delete-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitDelete(plan: DeleteNode, ctx: EmissionContext): Instruction {
	// DELETE node now only handles data transformations and passes flat rows through.
	// The actual database delete operations are handled by DmlExecutorNode.
	async function* run(ctx: RuntimeContext, flatRowsIterable: AsyncIterable<Row>): AsyncIterable<Row> {
		// Simply yield all flat rows from the source (which has already applied filtering, etc.)
		for await (const flatRow of flatRowsIterable) {
			yield flatRow;
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `deletePrep(${plan.table.tableSchema.name})`
	};
}
