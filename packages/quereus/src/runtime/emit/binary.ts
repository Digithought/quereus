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

	// Use plan-time type info to select a specialized run function
	const leftLogical = plan.left.getType().logicalType;
	const rightLogical = plan.right.getType().logicalType;

	let run: (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue) => SqlValue;
	let note: string;

	if (leftLogical.isTemporal || rightLogical.isTemporal) {
		// Temporal path: must check temporal arithmetic first
		run = function runTemporalArithmetic(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			const temporalResult = tryTemporalArithmetic(plan.expression.operator, v1, v2);
			if (temporalResult !== undefined) {
				return temporalResult;
			}

			if (v1 !== null && v2 !== null) {
				if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
					try {
						return innerBigInt(v1 as bigint, v2 as bigint);
					} catch {
						return null;
					}
				} else {
					const n1 = coerceToNumberForArithmetic(v1);
					const n2 = coerceToNumberForArithmetic(v2);
					try {
						const result = inner(n1, n2);
						if (!Number.isFinite(result)) return null;
						return result;
					} catch {
						return null;
					}
				}
			}
			return null;
		};
		note = `${plan.expression.operator}(temporal)`;
	} else if (leftLogical.isNumeric && rightLogical.isNumeric) {
		// Numeric-only path: skip temporal check and coercion entirely
		run = function runNumericOnly(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			if (v1 !== null && v2 !== null) {
				if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
					try {
						return innerBigInt(v1 as bigint, v2 as bigint);
					} catch {
						return null;
					}
				} else {
					try {
						const result = inner(v1 as number, v2 as number);
						if (!Number.isFinite(result)) return null;
						return result;
					} catch {
						return null;
					}
				}
			}
			return null;
		};
		note = `${plan.expression.operator}(numeric-fast)`;
	} else {
		// Generic path: temporal check + coercion (for TEXT or mixed types)
		run = function runGenericArithmetic(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			const temporalResult = tryTemporalArithmetic(plan.expression.operator, v1, v2);
			if (temporalResult !== undefined) {
				return temporalResult;
			}

			if (v1 !== null && v2 !== null) {
				if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
					try {
						return innerBigInt(v1 as bigint, v2 as bigint);
					} catch {
						return null;
					}
				} else {
					const n1 = coerceToNumberForArithmetic(v1);
					const n2 = coerceToNumberForArithmetic(v2);
					try {
						const result = inner(n1, n2);
						if (!Number.isFinite(result)) return null;
						return result;
					} catch {
						return null;
					}
				}
			}
			return null;
		};
		note = `${plan.expression.operator}(numeric)`;
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note
	};
}

export function emitComparisonOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
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

	// Use plan-time type info to select a specialized comparison path
	const leftLogical = leftType.logicalType;
	const rightLogical = rightType.logicalType;
	const needsTemporalCheck = leftLogical.isTemporal || rightLogical.isTemporal;
	const bothNumeric = leftLogical.isNumeric && rightLogical.isNumeric;
	const bothTextual = leftLogical.isTextual && rightLogical.isTextual;
	const bothSameCategory = bothNumeric || bothTextual;

	let run: (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue) => SqlValue;
	let noteTag: string;

	if (!needsTemporalCheck && bothSameCategory) {
		// Fast same-category comparison: no temporal check, no coercion needed
		// Use compareSqlValuesFast which handles runtime type mismatches gracefully
		const cmpToResult = buildCmpToResult(operator, plan);
		run = function runSameCategoryCompare(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			if (v1 === null || v2 === null) return null;
			return cmpToResult(compareSqlValuesFast(v1, v2, collationFunc));
		};
		noteTag = 'compare-fast';
	} else {
		// Generic path: temporal check + coercion
		run = buildGenericComparisonRun(operator, plan, collationFunc);
		noteTag = 'compare';
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: `${plan.expression.operator}(${noteTag}${collationName !== 'BINARY' ? ` ${collationName}` : ''})`
	};
}

/** Build a function that converts a numeric cmp result to a boolean for the given operator */
function buildCmpToResult(operator: string, plan: BinaryOpNode): (cmp: number) => boolean {
	switch (operator) {
		case '=':
		case '==':
			return (cmp: number) => cmp === 0;
		case '!=':
		case '<>':
			return (cmp: number) => cmp !== 0;
		case '<':
			return (cmp: number) => cmp < 0;
		case '<=':
			return (cmp: number) => cmp <= 0;
		case '>':
			return (cmp: number) => cmp > 0;
		case '>=':
			return (cmp: number) => cmp >= 0;
		default:
			quereusError(`Unsupported comparison operator: ${operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
	}
}

/** Build the generic (unspecialized) comparison run function with temporal + coercion */
function buildGenericComparisonRun(
	operator: string,
	plan: BinaryOpNode,
	collationFunc: ReturnType<typeof resolveCollation>
): (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue) => SqlValue {
	const cmpToResult = buildCmpToResult(operator, plan);
	return function runGenericComparison(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		if (v1 === null || v2 === null) return null;

		const temporalResult = tryTemporalComparison(operator, v1, v2);
		if (temporalResult !== undefined) return temporalResult;

		const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
		return cmpToResult(compareSqlValuesFast(coercedV1, coercedV2, collationFunc));
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

