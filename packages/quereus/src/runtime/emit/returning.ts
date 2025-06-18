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
	// Find row descriptors from the executor
	let newRowDescriptor: RowDescriptor = [];
	let oldRowDescriptor: RowDescriptor = [];
	let sourceRowDescriptor: RowDescriptor = [];

	// Try to get row descriptors from various sources
	const executor = plan.executor as any;
	
	// Get NEW row descriptor if available
	if (executor.newRowDescriptor && Object.keys(executor.newRowDescriptor).length > 0) {
		newRowDescriptor = executor.newRowDescriptor;
	} else if (executor.source?.newRowDescriptor && Object.keys(executor.source.newRowDescriptor).length > 0) {
		newRowDescriptor = executor.source.newRowDescriptor;
	}

	// Get OLD row descriptor if available
	if (executor.oldRowDescriptor && Object.keys(executor.oldRowDescriptor).length > 0) {
		oldRowDescriptor = executor.oldRowDescriptor;
	} else if (executor.source?.oldRowDescriptor && Object.keys(executor.source.oldRowDescriptor).length > 0) {
		oldRowDescriptor = executor.source.oldRowDescriptor;
	}

	// Fallback: create source row descriptor from executor attributes
	sourceRowDescriptor = buildRowDescriptor(plan.executor.getAttributes());

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
			// Clear any existing contexts to ensure projections resolve to the correct row
			rctx.context.clear();

			// Extract update metadata if this is an UPDATE operation
			const updateRowData = (sourceRow as any).__updateRowData;
			const isUpdateOperation = updateRowData?.isUpdateOperation;
			const oldRowKeyValues = (sourceRow as any).__oldRowKeyValues;

			// Set up the primary source context
			rctx.context.set(sourceRowDescriptor, () => sourceRow);

			try {
				// Set up OLD and NEW row contexts if available
				if (isUpdateOperation && updateRowData) {
					// For UPDATE operations, set up both OLD and NEW contexts
					if (Object.keys(oldRowDescriptor).length > 0) {
						rctx.context.set(oldRowDescriptor, () => updateRowData.oldRow); // OLD values
					}
					if (Object.keys(newRowDescriptor).length > 0) {
						rctx.context.set(newRowDescriptor, () => updateRowData.newRow); // NEW values
					}
				} else {
					// For INSERT/DELETE operations, set up single context
					if (Object.keys(newRowDescriptor).length > 0) {
						// INSERT: NEW values are the current row
						rctx.context.set(newRowDescriptor, () => sourceRow);
					}
					if (Object.keys(oldRowDescriptor).length > 0) {
						// DELETE: OLD values are the current row
						rctx.context.set(oldRowDescriptor, () => sourceRow);
					}
				}

				try {
					// Evaluate projection expressions in the context of this row
					const outputs = projectionCallbacks.map(func => func(rctx));
					const resolved = await Promise.all(outputs);
					yield resolved as Row;
				} finally {
					// Clean up OLD/NEW contexts
					if (Object.keys(oldRowDescriptor).length > 0) {
						rctx.context.delete(oldRowDescriptor);
					}
					if (Object.keys(newRowDescriptor).length > 0) {
						rctx.context.delete(newRowDescriptor);
					}
				}
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
