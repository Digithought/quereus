import type { Instruction, RuntimeContext } from '../types.js';
import type { InNode } from '../../planner/nodes/subquery.js';
import { emitPlanNode, emitCall } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { EmissionContext } from '../emission-context.js';

export function emitIn(plan: InNode, ctx: EmissionContext): Instruction {
	async function run(ctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
		for await (const row of input) {
			if (row.length > 0 && compareSqlValues(row[0], condition) === 0) {
				return 1; // true in SQL
			}
		}
		return 0; // false in SQL
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const conditionExpr = emitPlanNode(plan.condition, ctx);

	return {
		params: [sourceInstruction, conditionExpr],
		run: run as any,
		note: `IN (${plan.source.nodeType})`
	};
}
