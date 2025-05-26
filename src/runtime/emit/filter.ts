import type { FilterNode } from '../../planner/nodes/filter.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCall } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';

export function emitFilter(plan: FilterNode): Instruction {
	async function* run(ctx: RuntimeContext, sourceRows: AsyncIterable<Row>, predicate: (ctx: RuntimeContext) => SqlValue): AsyncIterable<Row> {
		for await (const sourceRow of sourceRows) {
			// Set up context for this row - the source relation should be available for column references
			ctx.context.set(plan.source, () => sourceRow);
			try {
				if (isTruthy(predicate(ctx))) {
					yield sourceRow;
				}
			} finally {
				// Clean up context for this row
				ctx.context.delete(plan.source);
			}
		}
	}

	const sourceInstruction = emitPlanNode(plan.source);
	const predicateFunc = emitCall(emitPlanNode(plan.predicate));


	return {
		params: [sourceInstruction, predicateFunc],
		run: run as any,
		note: `filter(predicate)`
	};
}

/**
 * Determines if a SqlValue is truthy for filter purposes.
 * In SQL semantics:
 * - NULL is falsy
 * - 0 (number) is falsy
 * - Empty string is falsy
 * - false (boolean) is falsy
 * - Everything else is truthy
 */
function isTruthy(value: SqlValue): boolean {
	return (typeof value === 'string') ? value.length > 0 : !!value;
}
