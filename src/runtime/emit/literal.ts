import type { SqlValue } from "../../common/types";
import type { Instruction, InstructionRun, RuntimeContext } from "../types";
import type { LiteralNode } from "../../planner/nodes/scalar";

export function emitLiteral(plan: LiteralNode): Instruction {
	function run(): SqlValue {
		return plan.expression.value;
	}

	return { params: [], run: run as InstructionRun }
}
