import { QuereusError } from "../common/errors.js";
import type { PlanNode } from "../planner/nodes/plan-node.js";
import type { PlanNodeType } from "../planner/nodes/plan-node-type.js";
import type { Instruction, InstructionRun, RuntimeContext } from "./types.js";
import { StatusCode, type OutputValue, type RuntimeValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { Scheduler } from "./scheduler.js";
import type { EmissionContext } from "./emission-context.js";

const log = createLogger('emitters');

export type EmitterFunc = (plan: PlanNode, ctx: EmissionContext) => Instruction;

/**
 * Metadata about an emitter's execution characteristics
 * Used by optimizer to make decisions about physical properties
 */
export interface EmitterMeta {
	/** Whether this emitter preserves input ordering */
	preservesOrdering?: boolean;

	/** Column indexes that must be ordered for this emitter to work efficiently */
	requiresOrdering?: number[];

	/** Whether this emitter can handle streaming input efficiently */
	supportsStreaming?: boolean;

	/** Whether this emitter produces deterministic output */
	isDeterministic?: boolean;

	/** Estimated CPU cost factor relative to other operations */
	cpuCostFactor?: number;

	/** Estimated memory usage factor */
	memoryCostFactor?: number;

	/** Free-text description for debugging */
	note?: string;
}

/**
 * Emitter registration with metadata
 */
interface EmitterRegistration {
	emitter: EmitterFunc;
	meta: EmitterMeta;
}

const emitters: Map<PlanNodeType, EmitterRegistration> = new Map();

export function registerEmitter(nodeType: PlanNodeType, emitter: EmitterFunc, meta: EmitterMeta = {}): void {
	emitters.set(nodeType, { emitter, meta });
	log(`Registered emitter for ${nodeType} with meta: %O`, meta);
}

/**
 * Get emitter metadata for a node type
 */
export function getEmitterMeta(nodeType: PlanNodeType): EmitterMeta | undefined {
	const registration = emitters.get(nodeType);
	return registration?.meta;
}

export function emitPlanNode(plan: PlanNode, ctx: EmissionContext): Instruction {
	const registration = emitters.get(plan.nodeType);
	if (!registration) {
		throw new QuereusError(`No emitter registered for ${plan.nodeType}`, StatusCode.ERROR);
	}
	return registration.emitter(plan, ctx);
}

/**
 * Compiles any plan node into a callable instruction that can be used as a function.
 * This enables the scheduler to create separate programs for functions and pass them
 * as callbacks to other instructions.
 */
export function emitCall(root: Instruction): Instruction {
	const program = new Scheduler(root);

	function run(ctx: RuntimeContext): OutputValue {
		return (innerCtx: RuntimeContext) => program.run(innerCtx);
	}

	return {
		params: [],
		run,
		note: `callback(${root.note})`,
		programs: [program]
	};
}

/**
 * Helper function to emit a plan node and wrap it as a callable instruction.
 * This is useful for emitters that need to create sub-instructions.
 */
export function emitCallFromPlan(plan: PlanNode, emissionCtx: EmissionContext): Instruction {
	const instruction = emitPlanNode(plan, emissionCtx);
	return emitCall(instruction);
}

/**
 * Creates an instruction that validates its schema dependencies before execution.
 * This should be used for instructions that captured schema objects during emission.
 */
export function createValidatedInstruction(
	params: Instruction[],
	run: InstructionRun,
	emissionCtx: EmissionContext,
	note?: string
): Instruction {
	// Only add validation if we actually captured schema objects
	if (emissionCtx.getCapturedObjectCount() === 0) {
		return { params, run, note };
	}

	// Wrap the run function to validate schema before execution
	const validatedRun: InstructionRun = (ctx: RuntimeContext, ...args: any[]) => {
		// Validate schema objects are still available
		emissionCtx.validateCapturedSchemaObjects();
		// If validation passes, run the original instruction
		return run(ctx, ...args);
	};

	return {
		params,
		run: validatedRun,
		note: note ? `validated(${note})` : 'validated',
		emissionContext: emissionCtx
	};
}
