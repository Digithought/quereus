import type { RecursiveCTENode } from '../../planner/nodes/recursive-cte-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
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
			let shouldYield = true;

			if (!plan.isUnionAll && seenRowsTree) {
				// Check if we've seen this row before using BTree lookup
				const insertPath = seenRowsTree.insert(row);
				shouldYield = insertPath.on; // Only yield if it's a new row
			}

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
			iterationCount++;
			log('Recursive CTE %s iteration %d, working table size: %d', plan.cteName, iterationCount, workingTable.length);

			const currentIteration = [...workingTable]; // Make a copy
			workingTable = []; // Clear working table for next iteration

			// Create a reusable working table iterable
			const workingTableIterable = new WorkingTableIterable(currentIteration, rctx, rowDescriptor);

			// Set up the working table in context for CTE references to access
			// Use a special context key that CTE references can look for
			const workingTableKey = `recursive_cte_working_table:${plan.cteName}`;
			const originalWorkingTable = (rctx as any)[workingTableKey];
			(rctx as any)[workingTableKey] = workingTableIterable;

			try {
				// Execute recursive case using the callback - let scheduler handle all instruction execution
				const recursiveResult = await recursiveCaseCallback(rctx);

				for await (const row of recursiveResult) {
					let shouldYield = true;

					if (!plan.isUnionAll && seenRowsTree) {
						// Check if we've seen this row before using BTree lookup
						const insertPath = seenRowsTree.insert(row);
						shouldYield = insertPath.on; // Only yield if it's a new row
					}

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
				// Restore original working table context
				if (originalWorkingTable !== undefined) {
					(rctx as any)[workingTableKey] = originalWorkingTable;
				} else {
					delete (rctx as any)[workingTableKey];
				}
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



