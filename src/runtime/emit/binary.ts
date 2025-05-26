import { StatusCode } from "../../common/types.js";
import { QuereusError } from "../../common/errors.js";
import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { BinaryOpNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import { compareSqlValues } from "../../util/comparison.js";

export function emitBinaryOp(plan: BinaryOpNode): Instruction {
	switch (plan.expression.operator) {
		case '+':
		case '-':
		case '*':
		case '/':
		case '%':
			return emitNumericOp(plan);
		case '=':
		case '!=':
		case '<>':
		case '<':
		case '<=':
		case '>':
		case '>=':
			return emitComparisonOp(plan);
		case '||':
			return emitConcatOp(plan);
		case 'AND':
		case 'OR':
			return emitLogicalOp(plan);
		// TODO: emitBitwise
		default:
			throw new QuereusError(`Unsupported binary operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
	}
}

export function emitNumericOp(plan: BinaryOpNode): Instruction {
	let inner: (v1: any, v2: any) => any;
	switch (plan.expression.operator) {
		case '+': inner = (v1, v2) => v1 + v2; break;
		case '-': inner = (v1, v2) => v1 - v2; break;
		case '*': inner = (v1, v2) => v1 * v2; break;
		case '/': inner = (v1, v2) => v1 / v2; break;
		case '%': inner = (v1, v2) => v1 % v2; break;
		default: throw new QuereusError(`Unsupported numeric operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
	}

	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		if (v1 !== null && v2 !== null) {
			if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
				try {
					return inner(BigInt(v1 as any), BigInt(v2 as any));
				} catch {
					return null;
				}
			} else {
				const n1 = Number(v1);
				const n2 = Number(v2);
				if (!isNaN(n1) && !isNaN(n2)) {
					try {
						const result = inner(n1 as any, n2 as any);
						if (!Number.isFinite(result)) {
							return null;
						}
						return result;
					} catch {
						return null;
					}
				}
			}
		}
		return null;
	}

	const leftExpr = emitPlanNode(plan.left);
	const rightExpr = emitPlanNode(plan.right);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: `${plan.expression.operator}(numeric)`
	};
}

export function emitComparisonOp(plan: BinaryOpNode): Instruction {
	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		switch (plan.expression.operator) {
			case '=': return compareSqlValues(v1, v2) === 0 ? 1 : 0;
			case '!=':
			case '<>': return compareSqlValues(v1, v2) !== 0 ? 1 : 0;
			case '<': return compareSqlValues(v1, v2) < 0 ? 1 : 0;
			case '<=': return compareSqlValues(v1, v2) <= 0 ? 1 : 0;
			case '>': return compareSqlValues(v1, v2) > 0 ? 1 : 0;
			case '>=': return compareSqlValues(v1, v2) >= 0 ? 1 : 0;
			default:
				throw new QuereusError(`Unsupported comparison operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
		}
	}

	const leftExpr = emitPlanNode(plan.left);
	const rightExpr = emitPlanNode(plan.right);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: `${plan.expression.operator}(compare)`
	};
}

export function emitConcatOp(plan: BinaryOpNode): Instruction {
	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		// SQL concatenation: NULL || anything -> NULL
		if (v1 === null || v2 === null) return null;

		// Convert both operands to strings
		const s1 = String(v1);
		const s2 = String(v2);
		return s1 + s2;
	}

	const leftExpr = emitPlanNode(plan.left);
	const rightExpr = emitPlanNode(plan.right);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: '||(concat)'
	};
}

export function emitLogicalOp(plan: BinaryOpNode): Instruction {
	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		// SQL three-valued logic
		switch (plan.expression.operator) {
			case 'AND':
				// NULL AND x -> NULL if x is true or NULL, otherwise 0
				// 0 AND x -> 0
				// 1 AND x -> x
				if (v1 === null) {
					return (v2 === null || v2) ? null : 0;
				}
				if (!v1) return 0;
				return v2 === null ? null : (v2 ? 1 : 0);

			case 'OR':
				// NULL OR x -> NULL if x is false or NULL, otherwise 1
				// 1 OR x -> 1
				// 0 OR x -> x
				if (v1 === null) {
					return (v2 === null || !v2) ? null : 1;
				}
				if (v1) return 1;
				return v2 === null ? null : (v2 ? 1 : 0);

			default:
				throw new QuereusError(`Unsupported logical operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
		}
	}

	const leftExpr = emitPlanNode(plan.left);
	const rightExpr = emitPlanNode(plan.right);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: `${plan.expression.operator}(logical)`
	};
}

