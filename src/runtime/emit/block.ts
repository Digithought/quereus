import type { BlockNode } from '../../planner/nodes/block.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { RuntimeValue, OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitBlock(plan: BlockNode, ctx: EmissionContext): Instruction {
	const statements = plan.statements.map(stmt => emitPlanNode(stmt, ctx));

	function run(ctx: RuntimeContext, ...args: RuntimeValue[]): OutputValue {
		// For blocks, we just return the args as they came in
		// The actual execution of statements is handled by the scheduler
		return args as OutputValue;
	}

	return {
		params: statements,
		run,
		note: `block(${plan.statements.length} stmts)`
	};
}
