import { StatusCode } from "../../common/types";
import { SqliterError } from "../../common/errors";
import type { SqlValue } from "../../common/types";
import type { RuntimeContext } from "../types";
import type { BinaryOpNode } from "../../planner/nodes/scalar";

export function emitBinaryOp(plan: BinaryOpNode) {
	let inner: (v1: bigint, v2: bigint) => bigint;
	switch (plan.expression.operator) {
		case '+': inner = (v1, v2) => v1 + v2; break;
		case '-': inner = (v1, v2) => v1 - v2; break;
		case '*': inner = (v1, v2) => v1 * v2; break;
		case '/': inner = (v1, v2) => v1 / v2; break;
		case 'AND': inner = (v1, v2) => v1 && v2; break;
		case 'OR': inner = (v1, v2) => v1 || v2; break;
		// TODO: other operators
		default: throw new SqliterError(`Unsupported binary operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
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
						if (typeof result === 'number' && !Number.isFinite(result)) {
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

	const left = emitScalarExpression(plan.left);
	const right = emitScalarExpression(plan.right);

	return { params: [left, right], run }
}
