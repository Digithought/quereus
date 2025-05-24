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
			return emitNumericOp(plan);
		case '=':
		case '!=':
		case '<>':
		case '<':
		case '<=':
		case '>':
		case '>=':
			return emitComparisonOp(plan);
		// TODO: emitConcat
		// TODO: emitBitwise
		// TODO: emitLogical
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
		// TODO: check all of these and add other operators
		default: throw new QuereusError(`Unsupported binary operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
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

	const left = emitPlanNode(plan.left);
	const right = emitPlanNode(plan.right);

	return { params: [left, right], run: run as InstructionRun };
}

export function emitComparisonOp(plan: BinaryOpNode): Instruction {
	let run: (...args: any[]) => any;	// Be permissive rather than cast all of the overloads
	switch (plan.expression.operator) {
		case '=': run = (ctx, v1: SqlValue, v2: SqlValue) => compareSqlValues(v1, v2) === 0 ? 1 : 0; break;
		case '!=':
		case '<>': run = (ctx, v1: SqlValue, v2: SqlValue) => compareSqlValues(v1, v2) !== 0 ? 1 : 0; break;
		case '<': run = (ctx, v1: SqlValue, v2: SqlValue) => compareSqlValues(v1, v2) < 0 ? 1 : 0; break;
		case '<=': run = (ctx, v1: SqlValue, v2: SqlValue) => compareSqlValues(v1, v2) <= 0 ? 1 : 0; break;
		case '>': run = (ctx, v1: SqlValue, v2: SqlValue) => compareSqlValues(v1, v2) > 0 ? 1 : 0; break;
		case '>=': run = (ctx, v1: SqlValue, v2: SqlValue) => compareSqlValues(v1, v2) >= 0 ? 1 : 0; break;
		default:
			throw new QuereusError(`Unsupported comparison operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
	}

	const left = emitPlanNode(plan.left);
	const right = emitPlanNode(plan.right);

	return { params: [left, right], run: run as InstructionRun };
}

