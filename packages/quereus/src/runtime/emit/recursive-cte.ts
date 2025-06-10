import type { RecursiveCTENode } from '../../planner/nodes/recursive-cte-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan, emitPlanNode, createValidatedInstruction } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { RowDescriptor, TableDescriptor } from '../../planner/nodes/plan-node.js';
import { createLogger } from '../../common/logger.js';
import { BTree } from 'inheritree';
import { compareRows } from '../../util/comparison.js';
import { WorkingTableIterable } from '../../util/working-table-iterable.js';
import { DEFAULT_TUNING } from '../../planner/optimizer-tuning.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

const log = createLogger('runtime:emit:recursive-cte');

export function emitRecursiveCTE(plan: RecursiveCTENode, ctx: EmissionContext): Instruction {
	// Create row descriptor for CTE output attributes
	const rowDescriptor: RowDescriptor = [];
	const attributes = plan.getAttributes();
	attributes.forEach((attr, index) => {
		rowDescriptor[attr.id] = index;
	});

	// Use the plan's table descriptor for table context coordination
	const { tableDescriptor } = plan;

	async function* run(rctx: RuntimeContext, baseCaseResult: AsyncIterable<Row>, recursiveCaseCallback: (ctx: RuntimeContext) => AsyncIterable<Row>): AsyncIterable<Row> {
		log('Starting recursive CTE execution for %s (union=%s, algorithm=semi-naive)', plan.cteName, plan.isUnionAll ? 'ALL' : 'DISTINCT');

		// Get configuration - use plan node limit if specified, otherwise use default tuning
		const maxIterations = plan.maxRecursion ?? DEFAULT_TUNING.recursiveCte.maxIterations;

		// Step 1: Initialize deduplication storage (for UNION DISTINCT) and delta tracking
		const allRowsTree = plan.isUnionAll ? null : new BTree<Row, Row>(
			(row: Row) => row, // Identity function - use row as its own key
			compareRows
		);
		let deltaRows: Row[] = [];

		// Step 2: Execute base case and populate initial delta
		// Stream base case results immediately while building delta for next iteration
		for await (const row of baseCaseResult) {
			// Yield if we're union all or if the row is new
			const shouldYield = !allRowsTree || allRowsTree.insert(row).on;

			if (shouldYield) {
				// Yield immediately (streaming)
				rctx.context.set(rowDescriptor, () => row);
				try {
					yield row;
				} finally {
					rctx.context.delete(rowDescriptor);
				}

				// Add to delta for recursive processing (deep copy to avoid reference issues)
				deltaRows.push([...row] as Row);
			}
		}

		// Step 3: Semi-naïve iterative recursive execution
		let iterationCount = 0;

		while (deltaRows.length > 0 && (maxIterations === 0 || iterationCount < maxIterations)) {
			++iterationCount;
			log('Recursive CTE %s iteration %d, delta size: %d', plan.cteName, iterationCount, deltaRows.length);

			// Create a working table iterable from ONLY the delta (not all accumulated rows)
			const deltaIterable = new WorkingTableIterable([...deltaRows], rctx, rowDescriptor);
			const newDeltaRows: Row[] = []; // Collect rows for next iteration

			// Set up the delta table in context for CTE references to access
			rctx.tableContexts.set(tableDescriptor, () => deltaIterable);
			try {
				// Execute recursive case using the callback - it only sees the delta
				for await (const row of recursiveCaseCallback(rctx)) {
					// For UNION DISTINCT: check if row is new; for UNION ALL: accept all rows
					const shouldYield = !allRowsTree || allRowsTree.insert(row).on;

					if (shouldYield) {
						// Stream the row immediately
						rctx.context.set(rowDescriptor, () => row);
						try {
							yield row;
						} finally {
							rctx.context.delete(rowDescriptor);
						}

						// Add to next iteration's delta (deep copy to avoid reference issues)
						newDeltaRows.push([...row] as Row);
					}
				}
			} finally {
				rctx.tableContexts.delete(tableDescriptor);
			}

			// Update delta for next iteration - only new rows, not accumulated result
			deltaRows = newDeltaRows;
		}

		// Safety check for infinite recursion
		if (iterationCount >= maxIterations) {
			quereusError(
				`Recursive CTE '${plan.cteName}' exceeded maximum iteration limit (${maxIterations})`,
				StatusCode.ERROR
			);
		}

		log('Recursive CTE %s completed after %d iterations (semi-naive algorithm)', plan.cteName, iterationCount);
	}

	// Emit both base case and recursive case instructions
	const baseCaseInstruction = emitPlanNode(plan.baseCaseQuery, ctx);
	const recursiveCaseInstruction = emitCallFromPlan(plan.recursiveCaseQuery, ctx);

	return {
		params: [baseCaseInstruction, recursiveCaseInstruction],
		run,
		note: `recursiveCTE(${plan.cteName})`
	};
}



