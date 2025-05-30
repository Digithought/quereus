import type { SortNode } from '../../planner/nodes/sort.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { compareSqlValues } from '../../util/comparison.js';

export function emitSort(plan: SortNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const sortKeyInstructions = plan.sortKeys.map(key => emitCallFromPlan(key.expression, ctx));

	// Create row descriptor for source attributes
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	async function* run(
		ctx: RuntimeContext,
		source: AsyncIterable<Row>,
		...sortKeyFunctions: Array<(ctx: RuntimeContext) => SqlValue | Promise<SqlValue>>
	): AsyncIterable<Row> {

		// Collect all rows with their sort key values
		const rowsWithKeys: Array<{ row: Row; keys: SqlValue[] }> = [];

		for await (const sourceRow of source) {
			// Set up context for this row using row descriptor
			ctx.context.set(sourceRowDescriptor, () => sourceRow);

			try {
				// Evaluate sort key expressions
				const keys: SqlValue[] = [];
				for (const keyFunc of sortKeyFunctions) {
					keys.push(await keyFunc(ctx));
				}

				rowsWithKeys.push({ row: sourceRow, keys });
			} finally {
				// Clean up context for this row
				ctx.context.delete(sourceRowDescriptor);
			}
		}

		// Sort the collected rows
		rowsWithKeys.sort((a, b) => {
			for (let i = 0; i < plan.sortKeys.length; i++) {
				const sortKey = plan.sortKeys[i];
				const aValue = a.keys[i];
				const bValue = b.keys[i];

				let comparison = compareSqlValues(aValue, bValue);

				// Handle DESC order
				if (sortKey.direction === 'desc') {
					comparison = -comparison;
				}

				// Handle NULL ordering (defaults to nulls last for ASC, nulls first for DESC)
				if (aValue === null && bValue === null) {
					comparison = 0;
				} else if (aValue === null) {
					comparison = sortKey.nulls === 'first' ? -1 : 1;
				} else if (bValue === null) {
					comparison = sortKey.nulls === 'first' ? 1 : -1;
				}

				if (comparison !== 0) {
					return comparison;
				}
			}
			return 0;
		});

		// Yield sorted rows
		for (const { row } of rowsWithKeys) {
			yield row;
		}
	}

	return {
		params: [sourceInstruction, ...sortKeyInstructions],
		run: run as any,
		note: `sort(${plan.sortKeys.length} keys)`
	};
}
