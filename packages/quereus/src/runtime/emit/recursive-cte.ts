import type { RecursiveCTENode } from '../../planner/nodes/recursive-cte-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { RowDescriptor, TableDescriptor } from '../../planner/nodes/plan-node.js';
import { createLogger } from '../../common/logger.js';
import { BTree } from 'inheritree';
import { compareRows } from '../../util/comparison.js';
import { WorkingTableIterable } from '../../util/working-table-iterable.js';
import { DEFAULT_TUNING } from '../../planner/optimizer-tuning.js';

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
		log('Starting recursive CTE execution for %s (union=%s)', plan.cteName, plan.isUnionAll ? 'ALL' : 'DISTINCT');

		// Get configuration - use plan node limit if specified, otherwise use default tuning
		const maxIterations = plan.maxRecursion ?? DEFAULT_TUNING.recursiveCte.maxIterations;

		// Step 1: Initialize deduplication storage (for UNION DISTINCT) and working table
		const seenRowsTree = plan.isUnionAll ? null : new BTree<Row, Row>(
			(row: Row) => row, // Identity function - use row as its own key
			compareRows
		);
		let workingTable: Row[] = [];

		// Step 2: Execute base case and populate initial working table
		// Stream base case results immediately while building working table
		for await (const row of baseCaseResult) {
			// Yield if we're union all or if the row is new
			const shouldYield = !seenRowsTree || seenRowsTree.insert(row).on;

			if (shouldYield) {
				// Yield immediately (streaming)
				rctx.context.set(rowDescriptor, () => row);
				try {
					yield row;
				} finally {
					rctx.context.delete(rowDescriptor);
				}

				// Add to working table for recursive processing
				workingTable.push([...row] as Row); // Deep copy to avoid reference issues
			}
		}

		// Step 3: Iterative recursive execution
		let iterationCount = 0;

		while (workingTable.length > 0 && (maxIterations === 0 || iterationCount < maxIterations)) {
			++iterationCount;
			log('Recursive CTE %s iteration %d, working table size: %d', plan.cteName, iterationCount, workingTable.length);

			// Create a reusable working table iterable
			const workingTableIterable = new WorkingTableIterable([...workingTable], rctx, rowDescriptor);
			workingTable = []; // Clear working table for next iteration

			// Set up the working table in context for CTE references to access
			// Use a special context key that CTE references can look for
			rctx.tableContexts.set(tableDescriptor, () => workingTableIterable);
			try {
				// Execute recursive case using the callback
				for await (const row of recursiveCaseCallback(rctx)) {
					let shouldYield = !seenRowsTree || seenRowsTree.insert(row).on;

					if (shouldYield) {
						// Stream the row immediately
						rctx.context.set(rowDescriptor, () => row);
						try {
							yield row;
						} finally {
							rctx.context.delete(rowDescriptor);
						}

						// Add to working table for next iteration
						workingTable.push([...row] as Row); // Deep copy to avoid reference issues
					}
				}
			} finally {
				rctx.tableContexts.delete(tableDescriptor);
			}
		}

		if (maxIterations > 0 && iterationCount >= maxIterations) {
			throw new Error(`Recursive CTE '${plan.cteName}' exceeded maximum iteration limit (${maxIterations})`);
		}

		log('Recursive CTE %s completed after %d iterations', plan.cteName, iterationCount);
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



