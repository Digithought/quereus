import { StatusCode } from "../../common/types.js";
import { quereusError } from "../../common/errors.js";
import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { BinaryOpNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import { compareSqlValuesFast, resolveCollation } from "../../util/comparison.js";
import { coerceForComparison, coerceToNumberForArithmetic } from "../../util/coercion.js";
import { simpleLike } from "../../util/patterns.js";
import type { EmissionContext } from "../emission-context.js";
import { tryTemporalArithmetic, tryTemporalComparison } from "./temporal-arithmetic.js";

export function emitBinaryOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	// Normalize operator to uppercase for case-insensitive matching of keywords
	const operator = plan.expression.operator.toUpperCase();

	switch (operator) {
		case '+':
		case '-':
		case '*':
		case '/':
		case '%':
			return emitNumericOp(plan, ctx);
		case '=':
		case '==':
		case '!=':
		case '<>':
		case '<':
		case '<=':
		case '>':
		case '>=':
			return emitComparisonOp(plan, ctx);
		case '||':
			return emitConcatOp(plan, ctx);
		case 'AND':
		case 'OR':
		case 'XOR':
			return emitLogicalOp(plan, ctx);
		case 'LIKE':
			return emitLikeOp(plan, ctx);
		// TODO: emitBitwise
		default:
			quereusError(`Unsupported binary operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
	}
}

export function emitNumericOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	let inner: (v1: number, v2: number) => number;
	let innerBigInt: (v1: bigint, v2: bigint) => bigint;

	switch (plan.expression.operator) {
		case '+':
			inner = (v1, v2) => v1 + v2;
			innerBigInt = (v1, v2) => v1 + v2;
			break;
		case '-':
			inner = (v1, v2) => v1 - v2;
			innerBigInt = (v1, v2) => v1 - v2;
			break;
		case '*':
			inner = (v1, v2) => v1 * v2;
			innerBigInt = (v1, v2) => v1 * v2;
			break;
		case '/':
			inner = (v1, v2) => v1 / v2;
			innerBigInt = (v1, v2) => v1 / v2;
			break;
		case '%':
			inner = (v1, v2) => v1 % v2;
			innerBigInt = (v1, v2) => v1 % v2;
			break;
		default:
			quereusError(`Unsupported numeric operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
	}

	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		// Try temporal arithmetic first
		const temporalResult = tryTemporalArithmetic(plan.expression.operator, v1, v2);
		if (temporalResult !== undefined) {
			return temporalResult;
		}

		// Fall back to numeric arithmetic
		if (v1 !== null && v2 !== null) {
			if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
				try {
					return innerBigInt(v1 as bigint, v2 as bigint);
				} catch {
					return null;
				}
			} else {
				// Use shared coercion function for arithmetic context
				const n1 = coerceToNumberForArithmetic(v1);
				const n2 = coerceToNumberForArithmetic(v2);

				try {
					const result = inner(n1, n2);
					if (!Number.isFinite(result)) {
						return null;
					}
					return result;
				} catch {
					return null;
				}
			}
		}
		return null;
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: `${plan.expression.operator}(numeric)`
	};
}

export function emitComparisonOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	let run: (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue) => SqlValue;

	// Determine collation to use for comparison
	const leftType = plan.left.getType();
	const rightType = plan.right.getType();
	let collationName = 'BINARY';

	// Use collation from either operand (right side takes precedence for COLLATE expressions)
	if (rightType.collationName) {
		collationName = rightType.collationName;
	} else if (leftType.collationName) {
		collationName = leftType.collationName;
	}

	// Pre-resolve collation function for optimal performance
	const collationFunc = resolveCollation(collationName);

	const operator = plan.expression.operator;

	switch (operator) {
		case '=':
		case '==':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL = anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Try temporal comparison first
				const temporalResult = tryTemporalComparison(operator, v1, v2);
				if (temporalResult !== undefined) {
					return temporalResult;
				}

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) === 0;
			};
			break;
		case '!=':
		case '<>':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL != anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Try temporal comparison first
				const temporalResult = tryTemporalComparison(operator, v1, v2);
				if (temporalResult !== undefined) {
					return temporalResult;
				}

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) !== 0;
			};
			break;
		case '<':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL < anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Try temporal comparison first
				const temporalResult = tryTemporalComparison(operator, v1, v2);
				if (temporalResult !== undefined) {
					return temporalResult;
				}

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) < 0;
			};
			break;
		case '<=':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL <= anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Try temporal comparison first
				const temporalResult = tryTemporalComparison(operator, v1, v2);
				if (temporalResult !== undefined) {
					return temporalResult;
				}

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) <= 0;
			};
			break;
		case '>':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL > anything -> NULL
				if (v1 === null || v2 === null) {
					return null;
				}

				// Try temporal comparison first
				const temporalResult = tryTemporalComparison(operator, v1, v2);
				if (temporalResult !== undefined) {
					return temporalResult;
				}

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) > 0;
			};
			break;
		case '>=':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL >= anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Try temporal comparison first
				const temporalResult = tryTemporalComparison(operator, v1, v2);
				if (temporalResult !== undefined) {
					return temporalResult;
				}

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) >= 0;
			};
			break;
		default:
			quereusError(`Unsupported comparison operator: ${operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: `${plan.expression.operator}(compare${collationName !== 'BINARY' ? ` ${collationName}` : ''})`
	};
}

export function emitConcatOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		// SQL concatenation: NULL || anything -> NULL
		if (v1 === null || v2 === null) return null;

		// Convert both operands to strings
		const s1 = String(v1);
		const s2 = String(v2);
		return s1 + s2;
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: '||(concat)'
	};
}

export function emitLogicalOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	// Normalize operator to uppercase for case-insensitive matching
	const operator = plan.expression.operator.toUpperCase();

	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		// SQL three-valued logic
		switch (operator) {
			case 'AND': {
				// NULL AND x -> NULL if x is true or NULL, otherwise false
				// false AND x -> false
				// true AND x -> x
				if (v1 === null) {
					return (v2 === null || v2) ? null : false;
				}
				if (!v1) return false;
				return v2 === null ? null : (v2 ? true : false);
			}

			case 'OR': {
				// NULL OR x -> NULL if x is false or NULL, otherwise true
				// true OR x -> true
				// false OR x -> x
				if (v1 === null) {
					return (v2 === null || !v2) ? null : true;
				}
				if (v1) return true;
				return v2 === null ? null : (v2 ? true : false);
			}

			case 'XOR': {
				// NULL XOR x -> NULL
				// x XOR NULL -> NULL
				// false XOR false -> false
				// false XOR true -> true
				// true XOR false -> true
				// true XOR true -> false
				if (v1 === null || v2 === null) return null;
				const b1 = !!v1;
				const b2 = !!v2;
				return b1 !== b2;
			}

			default:
				quereusError(`Unsupported logical operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
		}
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: `${plan.expression.operator}(logical)`
	};
}

export function emitLikeOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	function run(ctx: RuntimeContext, text: SqlValue, pattern: SqlValue): SqlValue {
		// SQL LIKE logic: text LIKE pattern
		// NULL handling: if either operand is NULL, result is NULL
		if (text === null || pattern === null) {
			return null;
		}

		// Convert both operands to strings and perform LIKE matching
		const textStr = String(text);
		const patternStr = String(pattern);

		return simpleLike(patternStr, textStr);
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: 'LIKE(like)'
	};
}

