import type { RecursiveCTENode } from '../../planner/nodes/recursive-cte-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { createLogger } from '../../common/logger.js';
import { BTree } from 'inheritree';
import { compareSqlValues } from '../../util/comparison.js';
import { WorkingTableIterable } from '../../util/working-table-iterable.js';
import { DEFAULT_TUNING } from '../../planner/optimizer-tuning.js';

const log = createLogger('runtime:emit:recursive-cte');

/**
 * Compares two rows for SQL DISTINCT semantics using proper SQL value comparison.
 * Returns -1, 0, or 1 for BTree ordering.
 */
function compareRows(a: Row, b: Row): number {
	// Compare each value using SQL semantics
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const aVal = i < a.length ? a[i] : null;
		const bVal = i < b.length ? b[i] : null;
		const comparison = compareSqlValues(aVal, bVal);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return 0;
}

export function emitRecursiveCTE(plan: RecursiveCTENode, ctx: EmissionContext): Instruction {
	// Create row descriptor for CTE output attributes
	const rowDescriptor: RowDescriptor = [];
	const attributes = plan.getAttributes();
	attributes.forEach((attr, index) => {
		rowDescriptor[attr.id] = index;
	});

	// Emit both base case and recursive case instructions
	const baseCaseInstruction = emitPlanNode(plan.baseCaseQuery, ctx);
	const recursiveCaseInstruction = emitPlanNode(plan.recursiveCaseQuery, ctx);

	async function* run(rctx: RuntimeContext, baseCaseResult: AsyncIterable<Row>): AsyncIterable<Row> {
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

			// Execute recursive case with working table substitution
			const recursiveResult = await executeWithWorkingTable(
				recursiveCaseInstruction,
				rctx,
				plan.cteName,
				workingTableIterable
			);

			if (Symbol.asyncIterator in Object(recursiveResult)) {
				for await (const row of recursiveResult as AsyncIterable<Row>) {
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
			}
		}

		if (maxIterations > 0 && iterationCount >= maxIterations) {
			throw new Error(`Recursive CTE '${plan.cteName}' exceeded maximum iteration limit (${maxIterations})`);
		}

		log('Recursive CTE %s completed after %d iterations', plan.cteName, iterationCount);
	}

	return {
		params: [baseCaseInstruction],
		run,
		note: `recursiveCTE(${plan.cteName})`
	};
}

/**
 * Executes an instruction with working table substitution for CTE references
 */
async function executeWithWorkingTable(
	instruction: Instruction,
	rctx: RuntimeContext,
	cteName: string,
	workingTableIterable: AsyncIterable<Row>
): Promise<any> {
	// Check if this instruction is a CTE reference that needs substitution
	if (instruction.note && instruction.note.includes('cte_ref(')) {
		const match = instruction.note.match(/cte_ref\(([^)]+)\)/);
		if (match) {
			const referencedCteName = match[1].split(' AS ')[0]; // Remove alias part
			if (referencedCteName === cteName) {
				return workingTableIterable;
			}
		}
	}

	// For non-CTE instructions, recursively execute their parameters with substitution
	const substitutedParams: any[] = [];
	for (const param of instruction.params) {
		if (typeof param === 'object' && param !== null && 'run' in param) {
			// This is an instruction - execute it with substitution
			const result = await executeWithWorkingTable(param as Instruction, rctx, cteName, workingTableIterable);
			substitutedParams.push(result);
		} else {
			// This is a literal value
			substitutedParams.push(param);
		}
	}

	// Execute the instruction with substituted parameters
	return await instruction.run(rctx, ...substitutedParams);
}

