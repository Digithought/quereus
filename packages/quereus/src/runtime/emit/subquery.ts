import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import type { InNode, ScalarSubqueryNode, ExistsNode } from '../../planner/nodes/subquery.js';
import { emitPlanNode } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';
import { compareSqlValuesFast, resolveCollation } from '../../util/comparison.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { BTree } from 'inheritree';
import { ConstantNode } from '../../planner/nodes/plan-node.js';

export function emitScalarSubquery(plan: ScalarSubqueryNode, ctx: EmissionContext): Instruction {

	async function run(_rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
		let result: SqlValue = null;
		let seen = false;

		for await (const row of input) {
			if (seen) {
				throw new QuereusError('Scalar subquery returned more than one row', StatusCode.ERROR, undefined, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
			}
			if (row.length > 1) {
				throw new QuereusError('Subquery should return at most one column', StatusCode.ERROR);
			}
			result = row.length === 0 ? null : row[0];
			seen = true;
		}

		return result;
	}

	const innerInstruction = emitPlanNode(plan.subquery, ctx);

	return {
		params: [innerInstruction],
		run,
		note: 'SCALAR_SUBQUERY'
	};
}

export function emitIn(plan: InNode, ctx: EmissionContext): Instruction {
	// Extract collation from the condition expression
	const conditionType = plan.condition.getType();
	const collationName = conditionType.collationName || 'BINARY';
	const collation = resolveCollation(collationName);

	if (plan.source) {
		// IN subquery: expr IN (SELECT ...)
		// Use streaming approach - check each row as we read it, return early on match
		async function runSubqueryStreaming(_rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
			// If condition is NULL, result is NULL
			if (condition === null) {
				return null;
			}

			let hasNull = false;
			for await (const row of input) {
				if (row.length > 0) {
					const rowValue = row[0];
					if (rowValue === null) {
						hasNull = true;
						continue;
					}
					// Check for match immediately - no need to materialize
					if (compareSqlValuesFast(condition, rowValue, collation) === 0) {
						return 1; // Found a match
					}
				}
			}

			// No match found - if any value was NULL, result is NULL
			return hasNull ? null : 0;
		}

		const sourceInstruction = emitPlanNode(plan.source, ctx);
		const conditionExpr = emitPlanNode(plan.condition, ctx);

		return {
			params: [sourceInstruction, conditionExpr],
			run: runSubqueryStreaming as any,
			note: `IN (subquery)`
		};
	} else if (plan.values) {
		// IN value list: expr IN (value1, value2, ...)

		// Check if all values are truly constant (can be evaluated at emit time)
		const allConstant = plan.values.every(val => val.physical.constant);

		if (allConstant) {
			// Pre-build BTree at emit time for constant values
			const tree = new BTree<SqlValue, SqlValue>(
				(val: SqlValue) => val,
				(a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collation)
			);
			let hasNull = false;

			function innerConstantRun(_rctx: RuntimeContext, condition: SqlValue): SqlValue {
				// If condition is NULL, result is NULL
				if (condition === null) {
					return null;
				}

				// Check if condition exists in pre-built tree
				const path = tree.find(condition);
				if (path.on) {
					return 1; // Found a match
				}

				// No match found - if any value was NULL, result is NULL
				return hasNull ? null : 0;
			}

			const values = plan.values.map(val => (val as unknown as ConstantNode).getValue());

			let runFunc: InstructionRun;

			if (values.some(val => val instanceof Promise)) {
				// Must resolve promises at runtime
				runFunc = async (rctx: RuntimeContext, condition: SqlValue): Promise<SqlValue> => {
					const resolved = await Promise.all(values);

					for (const value of resolved) {
						if (value === null) {
							hasNull = true;
							continue;
						}
						tree.insert(value as SqlValue);
					}

					return innerConstantRun(rctx, condition);
				}
			} else {
				for (const value of values) {
					if (value === null) {
						hasNull = true;
						continue;
					}
					tree.insert(value as SqlValue);
				}
			runFunc = innerConstantRun;
			}

			const conditionExpr = emitPlanNode(plan.condition, ctx);

			return {
				params: [conditionExpr],
				run: runFunc as InstructionRun,
				note: `IN (${plan.values.length} constant values)`
			};
		} else {
			// Some values are expressions - build tree at runtime
			function runDynamicValues(_rctx: RuntimeContext, condition: SqlValue, ...values: SqlValue[]): SqlValue {
				// If condition is NULL, result is NULL
				if (condition === null) {
					return null;
				}

				// Linear scan is optimal since we're only doing one lookup per execution
				let hasNull = false;
				for (const value of values) {
					if (value === null) {
						hasNull = true;
						continue;
					}
					if (compareSqlValuesFast(condition, value, collation) === 0) {
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
				run: runDynamicValues as any,
				note: `IN (${plan.values.length} dynamic values)`
			};
		}
	} else {
		throw new QuereusError('IN node must have either source or values', StatusCode.INTERNAL);
	}
}

export function emitExists(plan: ExistsNode, ctx: EmissionContext): Instruction {
	async function run(_rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
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
