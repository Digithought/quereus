import type { Instruction, RuntimeContext } from '../types.js';
import type { InNode, ScalarSubqueryNode, ExistsNode } from '../../planner/nodes/subquery.js';
import { emitPlanNode } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { BTree } from 'inheritree';

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

			// Build BTree of all values from subquery
			const tree = new BTree<SqlValue, SqlValue>(
				(val: SqlValue) => val,
				(a: SqlValue, b: SqlValue) => compareSqlValues(a, b)
			);

			let hasNull = false;
			for await (const row of input) {
				if (row.length > 0) {
					const rowValue = row[0];
					if (rowValue === null) {
						hasNull = true;
						continue;
					}
					tree.insert(rowValue);
				}
			}

			// Check if condition exists in tree
			const value = tree.get(condition);
			if (value !== undefined) {
				return 1; // Found a match
			}

			// No match found - if any value was NULL, result is NULL
			return hasNull ? null : 0;
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

			// Build BTree of all values
			const tree = new BTree<SqlValue, SqlValue>(
				(val: SqlValue) => val,
				(a: SqlValue, b: SqlValue) => compareSqlValues(a, b)
			);

			let hasNull = false;
			for (const value of values) {
				if (value === null) {
					hasNull = true;
					continue;
				}
				tree.insert(value);
			}

			// Check if condition exists in tree
			const path = tree.find(condition);
			if (path.on) {
				return 1; // Found a match
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

export function emitExists(plan: ExistsNode, ctx: EmissionContext): Instruction {
	async function run(ctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
		for await (const _row of input) {
			return 1; // First row => TRUE
		}
		return 0; // Empty => FALSE
	}

	const innerInstruction = emitPlanNode(plan.subquery, ctx);

	return {
		params: [innerInstruction],
		run,
		note: 'EXISTS'
	};
}
