import type { Row } from '../../common/types.js';
import type { CTEReferenceNode } from '../../planner/nodes/cte-reference-node.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { withRowContextGenerator } from '../context-helpers.js';

export function emitCTEReference(plan: CTEReferenceNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for output attributes
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Standard CTE reference: Use normal instruction parameter approach
	async function* run(rctx: RuntimeContext, cteResult: AsyncIterable<Row>): AsyncIterable<Row> {
		// Execute the CTE and yield each row
		yield* withRowContextGenerator(rctx, rowDescriptor, cteResult, async function* (row) {
			yield row;
		});
	}

	// Emit the underlying CTE
	const cteInstruction = emitPlanNode(plan.source, ctx);

	return createValidatedInstruction(
		[cteInstruction],
		run as any,
		ctx,
		`cte_ref(${plan.source.cteName}${plan.alias ? ` AS ${plan.alias}` : ''})`
	);
}
