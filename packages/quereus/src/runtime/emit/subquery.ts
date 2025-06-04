import type { Instruction, RuntimeContext } from '../types.js';
import type { InNode, ScalarSubqueryNode } from '../../planner/nodes/subquery.js';
import { emitPlanNode } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export function emitScalarSubquery(plan: ScalarSubqueryNode, ctx: EmissionContext): Instruction {

	async function run(ctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
		let result: SqlValue = null;
		let seen = false;

		for await (const row of input) {
			if (seen) {
				throw new QuereusError('Scalar subquery returned more than one row', StatusCode.ERROR, undefined, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
			}
			seen = true;
			result = row[0];
		}

		return result;
	}

	const innerInstruction = emitPlanNode(plan.subquery, ctx);

	return {
		params: [innerInstruction],
		run,
		note: 'scalar subquery'
	};
}

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
