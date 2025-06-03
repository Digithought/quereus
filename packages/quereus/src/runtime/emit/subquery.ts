import type { Instruction, RuntimeContext } from '../types.js';
import type { InNode, ScalarSubqueryNode } from '../../planner/nodes/subquery.js';
import { emitPlanNode, emitCall } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { Scheduler } from '../scheduler.js';

export function emitScalarSubquery(plan: ScalarSubqueryNode, ctx: EmissionContext): Instruction {
	async function run(ctx: RuntimeContext): Promise<SqlValue> {
		try {
			// Clone the current runtime context to preserve outer query state
			// This ensures correlated column references can still be resolved
			const preservedContextEntries = new Map(ctx.context);

			// Execute the subquery using the scheduler with the current runtime context
			// This allows the subquery to access the outer row context for correlation
			const subqueryProgram = new Scheduler(subqueryInstruction);
			const subqueryResult = await subqueryProgram.run(ctx);

			// Restore the preserved context entries after subquery execution
			for (const [key, value] of preservedContextEntries) {
				ctx.context.set(key, value);
			}

			if (subqueryResult === null || subqueryResult === undefined) {
				throw new QuereusError('Scalar subquery returned null or undefined', StatusCode.ERROR);
			}

			// Check if the result has async iteration capabilities
			if (typeof subqueryResult !== 'object') {
				throw new QuereusError(`Scalar subquery returned invalid type: ${typeof subqueryResult}`, StatusCode.ERROR);
			}

			let count = 0;
			let result: SqlValue = null;

			// Iterate over the subquery result
			for await (const row of subqueryResult as AsyncIterable<Row>) {
				count++;
				if (count > 1) {
					throw new QuereusError('Scalar subquery returned more than one row', StatusCode.ERROR);
				}
				// For scalar subqueries, we expect exactly one column
				if (row.length === 0) {
					throw new QuereusError('Scalar subquery returned no columns', StatusCode.ERROR);
				}
				result = row[0];
			}

			return result;
		} catch (error) {
			if (error instanceof QuereusError) {
				throw error;
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			throw new QuereusError(`Scalar subquery execution failed: ${errorMessage}`, StatusCode.ERROR);
		}
	}

	// Emit the subquery plan
	const subqueryInstruction = emitPlanNode(plan.subquery, ctx);

	return {
		params: [],
		run,
		note: `scalar subquery`
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
