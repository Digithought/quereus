import type { RecursiveCTENode } from '../../planner/nodes/recursive-cte-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:recursive-cte');

/**
 * A reusable async iterable for working table data that can be iterated multiple times.
 * Similar to CachedIterable but for runtime-generated working table data.
 */
class WorkingTableIterable implements AsyncIterable<Row> {
	constructor(
		private rows: Row[],
		private rctx: RuntimeContext,
		private rowDescriptor: RowDescriptor
	) {}

	async *[Symbol.asyncIterator](): AsyncIterator<Row> {
		for (const row of this.rows) {
			// Set up context for this row using the CTE row descriptor
			this.rctx.context.set(this.rowDescriptor, () => row);
			try {
				yield row;
			} finally {
				// Clean up context
				this.rctx.context.delete(this.rowDescriptor);
			}
		}
	}
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
		log('Starting recursive CTE execution for %s', plan.cteName);

		// Step 1: Initialize result storage and working table
		const seenRows = new Set<string>(); // For UNION (distinct) deduplication
		const allResults: Row[] = [];
		let workingTable: Row[] = [];

		// Step 2: Execute base case and populate initial working table
		for await (const row of baseCaseResult) {
			const rowKey = plan.isUnionAll ? null : JSON.stringify(row);

			if (plan.isUnionAll || !seenRows.has(rowKey!)) {
				if (!plan.isUnionAll) {
					seenRows.add(rowKey!);
				}
				allResults.push(row);
				workingTable.push(row);
			}
		}

		// Step 3: Iterative recursive execution
		let iterationCount = 0;
		const maxIterations = 1000;

		while (workingTable.length > 0 && iterationCount < maxIterations) {
			iterationCount++;
			const currentIteration = [...workingTable]; // Make a copy
			workingTable = [];

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
					const rowKey = plan.isUnionAll ? null : JSON.stringify(row);

					if (plan.isUnionAll || !seenRows.has(rowKey!)) {
						if (!plan.isUnionAll) {
							seenRows.add(rowKey!);
						}
						allResults.push(row);
						workingTable.push(row);
					}
				}
			}
		}

		if (iterationCount >= maxIterations) {
			throw new Error(`Recursive CTE '${plan.cteName}' exceeded maximum iteration limit (${maxIterations})`);
		}

		log('Recursive CTE %s completed after %d iterations, total rows: %d',
			plan.cteName, iterationCount, allResults.length);

		// Step 4: Yield all results with proper context
		for (const row of allResults) {
			rctx.context.set(rowDescriptor, () => row);
			try {
				yield row;
			} finally {
				rctx.context.delete(rowDescriptor);
			}
		}
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

