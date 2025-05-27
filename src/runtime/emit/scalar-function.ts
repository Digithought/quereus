import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitScalarFunctionCall(plan: ScalarFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionName = plan.expression.name.toLowerCase();
	const numArgs = plan.operands.length;

	// Look up the function during emission and record the dependency
	const functionSchema = ctx.findFunction(functionName, numArgs);
	if (!functionSchema) {
		throw new QuereusError(`Unknown function: ${functionName}/${numArgs}`, StatusCode.ERROR);
	}
	if (functionSchema.type !== 'scalar') {
		throw new QuereusError(`Function ${functionName}/${numArgs} is not a scalar function`, StatusCode.ERROR);
	}

	function run(runtimeCtx: RuntimeContext, ...args: Array<SqlValue>): OutputValue {

		// Validate argument count
		if (functionSchema!.numArgs >= 0 && args.length !== functionSchema!.numArgs) {
			throw new QuereusError(`Function ${functionName} called with ${args.length} arguments, expected ${functionSchema!.numArgs}`, StatusCode.ERROR);
		}

		// Use the direct implementation
		if (!functionSchema!.scalarImpl) {
			throw new QuereusError(`Function ${functionName}/${numArgs} has no scalar implementation`, StatusCode.ERROR);
		}

		try {
			return functionSchema!.scalarImpl(...args);
		} catch (error: any) {
			throw new QuereusError(`Function ${functionName} failed: ${error.message}`, StatusCode.ERROR, error, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
		}
	}

	const operandExprs = plan.operands.map(operand => emitPlanNode(operand, ctx));

	return {
		params: [...operandExprs],
		run: run as any,
		note: `${plan.expression.name}(${plan.operands.length})`
	};
}
