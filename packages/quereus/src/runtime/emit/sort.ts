import type { SortNode } from '../../planner/nodes/sort.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createOrderByComparatorFast, resolveCollation } from '../../util/comparison.js';

export function emitSort(plan: SortNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Create row descriptor for source attributes
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	// Emit sort key instructions and pre-create optimized comparators with resolved collations
	const sortKeyInstructions = plan.sortKeys.map(key => emitCallFromPlan(key.expression, ctx));
	const sortKeyComparators = plan.sortKeys.map(key => {
		const keyType = key.expression.getType();
		const collationName = keyType.collationName || 'BINARY';
		const collationFunc = resolveCollation(collationName);
		return createOrderByComparatorFast(key.direction, key.nulls, collationFunc);
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

		// Sort the collected rows using pre-created optimized comparators
		rowsWithKeys.sort((a, b) => {
			for (let i = 0; i < sortKeyComparators.length; i++) {
				const comparator = sortKeyComparators[i];
				const aValue = a.keys[i];
				const bValue = b.keys[i];

				const comparison = comparator(aValue, bValue);

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
