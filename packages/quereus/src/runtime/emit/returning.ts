import type { ReturningNode } from '../../planner/nodes/returning-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';

export function emitReturning(plan: ReturningNode, ctx: EmissionContext): Instruction {
	// Build flat row descriptor from OLD/NEW descriptors if available
	let rowDescriptor: RowDescriptor = [];

	const executor = plan.executor as any;

	// Check if this is a mutation operation with OLD/NEW descriptors
	if (executor.oldRowDescriptor || executor.newRowDescriptor) {
		// Build flat row descriptor: OLD attributes at 0..n-1, NEW attributes at n..2n-1
		if (executor.oldRowDescriptor) {
			for (const attrIdStr in executor.oldRowDescriptor) {
				const attrId = parseInt(attrIdStr);
				const columnIndex = executor.oldRowDescriptor[attrId];
				if (columnIndex !== undefined) {
					rowDescriptor[attrId] = columnIndex; // OLD section: 0..n-1
				}
			}
		}

				if (executor.newRowDescriptor) {
			// Determine table column count from one of the descriptors
			const tableColumnCount = executor.table ? executor.table.tableSchema.columns.length :
				Math.max(
					...Object.values(executor.oldRowDescriptor || {}).filter((v): v is number => typeof v === 'number'),
					...Object.values(executor.newRowDescriptor || {}).filter((v): v is number => typeof v === 'number')
				) + 1;

			for (const attrIdStr in executor.newRowDescriptor) {
				const attrId = parseInt(attrIdStr);
				const columnIndex = executor.newRowDescriptor[attrId];
				if (columnIndex !== undefined) {
					rowDescriptor[attrId] = tableColumnCount + columnIndex; // NEW section: n..2n-1
				}
			}
		}
	} else {
		// Fallback: create row descriptor from executor attributes for non-mutation operations
		rowDescriptor = buildRowDescriptor(plan.executor.getAttributes());
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
