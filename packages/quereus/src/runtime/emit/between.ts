import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { BetweenNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import { compareSqlValuesFast, resolveCollation } from "../../util/comparison.js";
import { coerceForComparison } from "../../util/coercion.js";
import type { EmissionContext } from "../emission-context.js";

export function emitBetween(plan: BetweenNode, ctx: EmissionContext): Instruction {
	// Pre-resolve collation function for optimal performance (using BINARY as default for BETWEEN)
	const collationFunc = resolveCollation('BINARY');

	function run(ctx: RuntimeContext, value: SqlValue, lowerBound: SqlValue, upperBound: SqlValue): SqlValue {
		// SQL BETWEEN logic: value BETWEEN lower AND upper
		// Equivalent to: value >= lower AND value <= upper
		// NULL handling: if any operand is NULL, result is NULL
		if (value === null || lowerBound === null || upperBound === null) {
			return null;
		}

		// Apply type coercion before comparison
		const [coercedValue1, coercedLower] = coerceForComparison(value, lowerBound);
		const [coercedValue2, coercedUpper] = coerceForComparison(value, upperBound);

		// Use pre-resolved collation function for optimal performance
		const lowerResult = compareSqlValuesFast(coercedValue1, coercedLower, collationFunc);
		const upperResult = compareSqlValuesFast(coercedValue2, coercedUpper, collationFunc);

		// value >= lowerBound AND value <= upperBound
		const betweenResult = (lowerResult >= 0 && upperResult <= 0) ? 1 : 0;

		// Handle NOT BETWEEN
		if (plan.expression.not) {
			return betweenResult ? 0 : 1;
		}

		return betweenResult;
	}

	const valueExpr = emitPlanNode(plan.expr, ctx);
	const lowerExpr = emitPlanNode(plan.lower, ctx);
	const upperExpr = emitPlanNode(plan.upper, ctx);

	const notPrefix = plan.expression.not ? 'NOT ' : '';

	return {
		params: [valueExpr, lowerExpr, upperExpr],
		run: run as InstructionRun,
		note: `${notPrefix}BETWEEN`
	};
}
