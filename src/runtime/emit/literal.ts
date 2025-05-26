import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun } from "../types.js";
import type { LiteralNode } from "../../planner/nodes/scalar.js";
import { safeJsonStringify } from "../../util/serialization.js";

export function emitLiteral(plan: LiteralNode): Instruction {
	function run(): SqlValue {
		return plan.expression.value;
	}

	return {
		params: [],
		run: run as InstructionRun,
		note: `literal(${safeJsonStringify(plan.expression.value)})`
	};
}
