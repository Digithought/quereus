import type { Row } from '../../common/types.js';
import type { CTEReferenceNode } from '../../planner/nodes/cte-reference-node.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { PlanNodeType } from '../../planner/nodes/plan-node-type.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';

export function emitCTEReference(plan: CTEReferenceNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for output attributes
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Check if this is an internal recursive reference (inside the recursive case)
	// These use table context to access the working table
	const isInternalRecursiveRef = plan.source.nodeType === PlanNodeType.CTE && plan.source.isRecursive;

	if (isInternalRecursiveRef) {
		// Internal recursive CTE reference: Look up the working table from table contexts
		async function* run(rctx: RuntimeContext): AsyncIterable<Row> {
			const tableGetter = rctx.tableContexts.get(plan.source.tableDescriptor);
			if (!tableGetter) {
				throw new QuereusError(
					`Recursive CTE '${plan.source.cteName}' not found in table context`,
					StatusCode.INTERNAL
				);
			}

			// Execute the working table and yield each row
			for await (const row of tableGetter()) {
				// Set up context for this row using row descriptor
				rctx.context.set(rowDescriptor, () => row);
				try {
					yield row;
				} finally {
					// Clean up context
					rctx.context.delete(rowDescriptor);
				}
			}
		}

		return createValidatedInstruction(
			[], // No instruction parameters - data comes from table context
			run as any,
			ctx,
			`cte_ref(internal_recursive ${plan.source.cteName}${plan.alias ? ` AS ${plan.alias}` : ''})`
		);
	} else {
		// External CTE reference (or non-recursive): Use normal instruction parameter approach
		async function* run(rctx: RuntimeContext, cteResult: AsyncIterable<Row>): AsyncIterable<Row> {
			// Execute the CTE and yield each row
			for await (const row of cteResult) {
				// Set up context for this row using row descriptor
				rctx.context.set(rowDescriptor, () => row);
				try {
					yield row;
				} finally {
					// Clean up context
					rctx.context.delete(rowDescriptor);
				}
			}
		}

		// Emit the underlying CTE
		const cteInstruction = emitPlanNode(plan.source, ctx);

		return createValidatedInstruction(
			[cteInstruction],
			run as any,
			ctx,
			`cte_ref(${plan.source.isRecursive ? 'external_recursive' : 'non_recursive'} ${plan.source.cteName}${plan.alias ? ` AS ${plan.alias}` : ''})`
		);
	}
}
