import type { RecursiveCTENode } from '../../planner/nodes/recursive-cte-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';

export function emitRecursiveCTE(plan: RecursiveCTENode, ctx: EmissionContext): Instruction {
	// Emit instructions for both base case and recursive case
	const baseCaseInstruction = emitPlanNode(plan.baseCaseQuery, ctx);
	const recursiveCaseInstruction = emitPlanNode(plan.recursiveCaseQuery, ctx);

	async function* run(rctx: RuntimeContext): AsyncIterable<Row> {
		// Step 1: Initialize result storage
		const seenRows = new Set<string>(); // For UNION (distinct) deduplication
		const allResults: Row[] = [];
		let workingTable: Row[] = [];

		// Step 2: Execute base case
		for await (const row of baseCaseInstruction.run(rctx) as AsyncIterable<Row>) {
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
		const maxIterations = 1000; // Safety limit to prevent infinite recursion

		while (workingTable.length > 0 && iterationCount < maxIterations) {
			iterationCount++;
			const currentIteration = workingTable;
			workingTable = [];

			// TODO: Implement proper table substitution - pipeline the recursive case

			// For now, we'll use a simplified approach where the recursive case
			// is executed with the current working table available as input.
			// In a full implementation, this would require proper table substitution
			// or a more sophisticated runtime context modification.

			// Execute recursive case
			// Note: This is a simplified implementation that may not handle
			// complex recursive references correctly. A full implementation
			// would need to properly substitute the CTE reference with the
			// working table data.
			for await (const row of recursiveCaseInstruction.run(rctx) as AsyncIterable<Row>) {
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

		if (iterationCount >= maxIterations) {
			throw new Error(`Recursive CTE '${plan.cteName}' exceeded maximum iteration limit (${maxIterations})`);
		}

		// Step 4: Yield all results
		for (const row of allResults) {
			yield row;
		}
	}

	return {
		params: [baseCaseInstruction, recursiveCaseInstruction],
		run,
		note: `recursiveCTE(${plan.cteName}, iterations)`
	};
}

