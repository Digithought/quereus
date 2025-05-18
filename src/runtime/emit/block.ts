import type { RuntimeValue } from "../../common/types.js";
import type { BlockNode } from "../../planner/nodes/block.js";
import { emitPlanNode } from "../emitters.js";
import type { Instruction, RuntimeContext } from "../types.js";

export function emitBlock(plan: BlockNode): Instruction {
	function run(ctx: RuntimeContext, ...args: RuntimeValue[]) {
		return args;
	}

	return { params: plan.statements.map(node => emitPlanNode(node)), run };
}
