import { StatusCode } from "../../common/types.js";
import { QuereusError } from "../../common/errors.js";
import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { UnaryOpNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import type { EmissionContext } from "../emission-context.js";
import { isTruthy } from "../../util/comparison.js";

export function emitUnaryOp(plan: UnaryOpNode, ctx: EmissionContext): Instruction {
	// Select the operation function at emit time
	let run: (ctx: RuntimeContext, operand: SqlValue) => SqlValue;
	let note: string;

	// Normalize operator to uppercase for case-insensitive matching
	const operator = plan.expression.operator.toUpperCase();

	switch (operator) {
		case 'NOT':
			run = (ctx: RuntimeContext, operand: SqlValue) => {
				// SQL NOT: NULL -> NULL, 0 -> 1, anything else -> 0
				if (operand === null) return null;
				return isTruthy(operand) ? 0 : 1;
			};
			note = 'NOT';
			break;

		case 'IS NULL':
			run = (ctx: RuntimeContext, operand: SqlValue) => {
				return operand === null ? 1 : 0;
			};
			note = 'IS NULL';
			break;

		case 'IS NOT NULL':
			run = (ctx: RuntimeContext, operand: SqlValue) => {
				return operand !== null ? 1 : 0;
			};
			note = 'IS NOT NULL';
			break;

		case '-':
			run = (ctx: RuntimeContext, operand: SqlValue) => {
				if (operand === null) return null;
				if (typeof operand === 'number') return -operand;
				if (typeof operand === 'bigint') return -operand;
				// Try to convert to number
				const num = Number(operand);
				return isNaN(num) ? null : -num;
			};
			note = 'unary -';
			break;

		case '+':
			run = (ctx: RuntimeContext, operand: SqlValue) => {
				// Unary plus - convert to number if possible
				if (operand === null) return null;
				if (typeof operand === 'number' || typeof operand === 'bigint') return operand;
				const plusNum = Number(operand);
				return isNaN(plusNum) ? null : plusNum;
			};
			note = 'unary +';
			break;

		case '~':
			run = (ctx: RuntimeContext, operand: SqlValue) => {
				if (operand === null) return null;
				if (typeof operand === 'bigint') return ~operand;
				// Convert to integer and apply bitwise NOT
				const num = Number(operand);
				if (isNaN(num)) return null;
				return ~Math.trunc(num);
			};
			note = 'bitwise ~';
			break;

		default:
			throw new QuereusError(`Unsupported unary operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED);
	}

	const operandExpr = emitPlanNode(plan.operand, ctx);

	return {
		params: [operandExpr],
		run: run as InstructionRun,
		note
	};
}
