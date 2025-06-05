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
	if (plan.source) {
		// IN subquery: expr IN (SELECT ...)
		async function runSubquery(ctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
			// If condition is NULL, result is NULL
			if (condition === null) {
				return null;
			}

			for await (const row of input) {
				if (row.length > 0) {
					const rowValue = row[0];
					if (rowValue === null) {
						// If any value in the subquery is NULL and we haven't found a match yet,
						// we need to continue checking. If no match is found, result will be NULL.
						continue;
					}
					if (compareSqlValues(rowValue, condition) === 0) {
						return 1; // Found a match
					}
				}
			}

			// No match found - check if any value in the subquery was NULL
			// This requires a second pass, which is inefficient. For now, we'll assume no NULLs
			// TODO: Optimize this by collecting all values first
			return 0; // false in SQL
		}

		const sourceInstruction = emitPlanNode(plan.source, ctx);
		const conditionExpr = emitPlanNode(plan.condition, ctx);

		return {
			params: [sourceInstruction, conditionExpr],
			run: runSubquery as any,
			note: `IN (subquery)`
		};
	} else if (plan.values) {
		// IN value list: expr IN (value1, value2, ...)
		function runValues(ctx: RuntimeContext, condition: SqlValue, ...values: SqlValue[]): SqlValue {
			// If condition is NULL, result is NULL
			if (condition === null) {
				return null;
			}

			let hasNull = false;
			for (const value of values) {
				if (value === null) {
					hasNull = true;
					continue;
				}
				if (compareSqlValues(condition, value) === 0) {
					return 1; // Found a match
				}
			}

			// No match found - if any value was NULL, result is NULL
			return hasNull ? null : 0;
		}

		const conditionExpr = emitPlanNode(plan.condition, ctx);
		const valueExprs = plan.values.map(val => emitPlanNode(val, ctx));

		return {
			params: [conditionExpr, ...valueExprs],
			run: runValues as any,
			note: `IN (${plan.values.length} values)`
		};
	} else {
		throw new QuereusError('IN node must have either source or values', StatusCode.INTERNAL);
	}
}
