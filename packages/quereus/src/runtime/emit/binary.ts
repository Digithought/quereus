import { StatusCode } from "../../common/types.js";
import { QuereusError } from "../../common/errors.js";
import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { BinaryOpNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import { compareSqlValuesFast, resolveCollation } from "../../util/comparison.js";
import { coerceForComparison, coerceToNumberForArithmetic } from "../../util/coercion.js";
import { simpleLike } from "../../util/patterns.js";
import type { EmissionContext } from "../emission-context.js";

export function emitBinaryOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	switch (plan.expression.operator) {
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
			throw new QuereusError(`Unsupported binary operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
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
			throw new QuereusError(`Unsupported numeric operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
	}

	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
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

	switch (plan.expression.operator) {
		case '=':
		case '==':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL = anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) === 0 ? 1 : 0;
			};
			break;
		case '!=':
		case '<>':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL != anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) !== 0 ? 1 : 0;
			};
			break;
		case '<':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL < anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) < 0 ? 1 : 0;
			};
			break;
		case '<=':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL <= anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) <= 0 ? 1 : 0;
			};
			break;
		case '>':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL > anything -> NULL
				if (v1 === null || v2 === null) {
					return null;
				}

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				const comparisonResult = compareSqlValuesFast(coercedV1, coercedV2, collationFunc);
				const finalResult = comparisonResult > 0 ? 1 : 0;
				return finalResult;
			};
			break;
		case '>=':
			run = (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue => {
				// SQL comparison: NULL >= anything -> NULL
				if (v1 === null || v2 === null) return null;

				// Apply type coercion before comparison
				const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
				return compareSqlValuesFast(coercedV1, coercedV2, collationFunc) >= 0 ? 1 : 0;
			};
			break;
		default:
			throw new QuereusError(`Unsupported comparison operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
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
	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		// SQL three-valued logic
		switch (plan.expression.operator) {
			case 'AND': {
				// NULL AND x -> NULL if x is true or NULL, otherwise 0
				// 0 AND x -> 0
				// 1 AND x -> x
				if (v1 === null) {
					return (v2 === null || v2) ? null : 0;
				}
				if (!v1) return 0;
				return v2 === null ? null : (v2 ? 1 : 0);
			}

			case 'OR': {
				// NULL OR x -> NULL if x is false or NULL, otherwise 1
				// 1 OR x -> 1
				// 0 OR x -> x
				if (v1 === null) {
					return (v2 === null || !v2) ? null : 1;
				}
				if (v1) return 1;
				return v2 === null ? null : (v2 ? 1 : 0);
			}

			case 'XOR': {
				// NULL XOR x -> NULL
				// x XOR NULL -> NULL
				// 0 XOR 0 -> 0
				// 0 XOR 1 -> 1
				// 1 XOR 0 -> 1
				// 1 XOR 1 -> 0
				if (v1 === null || v2 === null) return null;
				const b1 = v1 ? 1 : 0;
				const b2 = v2 ? 1 : 0;
				return b1 !== b2 ? 1 : 0;
			}

			default:
				throw new QuereusError(`Unsupported logical operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
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

		return simpleLike(patternStr, textStr) ? 1 : 0;
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: 'LIKE(like)'
	};
}

