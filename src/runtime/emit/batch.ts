import type { RuntimeValue } from "../../common/types.js";
import type { BatchNode } from "../../planner/nodes/batch.js";
import { emitPlanNode } from "../emitters.js";
import type { Instruction, RuntimeContext } from "../types.js";

export function emitBatch(plan: BatchNode): Instruction {
	function run(ctx: RuntimeContext, ...args: RuntimeValue[]) {
		return args;
	}

	return { params: plan.statements.map(node => emitPlanNode(node)), run };
}