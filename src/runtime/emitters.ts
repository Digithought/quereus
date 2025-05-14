import { SqliterError } from "../common/errors.js";
import type { PlanNode } from "../planner/nodes/plan-node.js";
import type { PlanNodeType } from "../planner/nodes/plan-node-type.js";
import type { Instruction } from "./types.js";

export type EmitterFunc = (plan: PlanNode) => Instruction;

const emitters: Map<PlanNodeType, EmitterFunc> = new Map();

export function registerEmitter(planNodeType: PlanNodeType, emit: EmitterFunc): void {
	emitters.set(planNodeType, emit);
}

export function emitPlanNode(plan: PlanNode): Instruction {
	const emitter = emitters.get(plan.nodeType);
	if (!emitter) {
		throw new SqliterError(`No emitter registered for plan node type ${plan.nodeType}`);
	}
	return emitter(plan);
}