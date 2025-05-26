import { QuereusError } from "../common/errors.js";
import type { PlanNode } from "../planner/nodes/plan-node.js";
import type { PlanNodeType } from "../planner/nodes/plan-node-type.js";
import type { Instruction, InstructionRun, RuntimeContext } from "./types.js";
import { StatusCode, type OutputValue, type RuntimeValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { Scheduler } from "./scheduler.js";

const log = createLogger('emitters');

export type EmitterFunc = (plan: PlanNode) => Instruction;

const emitters: Map<PlanNodeType, EmitterFunc> = new Map();

export function registerEmitter(nodeType: PlanNodeType, emitter: EmitterFunc): void {
	emitters.set(nodeType, emitter);
	log(`Registered emitter for ${nodeType}`);
}

export function emitPlanNode(plan: PlanNode): Instruction {
	const emitter = emitters.get(plan.nodeType);
	if (!emitter) {
		throw new QuereusError(`No emitter registered for plan node type: ${plan.nodeType}`, StatusCode.INTERNAL);
	}
	return emitter(plan);
}

/**
 * Compiles any plan node into a callable instruction that can be used as a function.
 * This enables the scheduler to create separate programs for functions and pass them
 * as callbacks to other instructions.
 */
export function emitCall(root: Instruction): Instruction {
	const program = new Scheduler(root);

	function run(ctx: RuntimeContext, ...args: RuntimeValue[]): OutputValue | Promise<OutputValue> {
		return (ctx: RuntimeContext) => program.run(ctx);
	}

	return {
		params: [],
		run,
		note: `callback(${root.note})`,
		programs: [program]
	};
}
