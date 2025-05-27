import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { FunctionSchema } from '../../schema/function.js';

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

	// Capture the function key for runtime retrieval
	const functionKey = `function:${functionName}/${numArgs}`;

	function run(runtimeCtx: RuntimeContext, ...args: Array<SqlValue>): OutputValue {
		// Use the captured function schema instead of doing a fresh lookup
		const capturedFunction = ctx.getCapturedSchemaObject<FunctionSchema>(functionKey);
		if (!capturedFunction) {
			throw new QuereusError(`Function ${functionName}/${numArgs} was not captured during emission`, StatusCode.INTERNAL);
		}

		// Validate argument count
		if (capturedFunction.numArgs >= 0 && args.length !== capturedFunction.numArgs) {
			throw new QuereusError(`Function ${functionName} called with ${args.length} arguments, expected ${capturedFunction.numArgs}`, StatusCode.ERROR);
		}

		// Use the direct implementation
		if (!capturedFunction.scalarImpl) {
			throw new QuereusError(`Function ${functionName}/${numArgs} has no scalar implementation`, StatusCode.ERROR);
		}

		try {
			return capturedFunction.scalarImpl(...args);
		} catch (error: any) {
			throw new QuereusError(`Function ${functionName} failed: ${error.message}`, StatusCode.ERROR, error, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
		}
	}

	const operandExprs = plan.operands.map(operand => emitPlanNode(operand, ctx));

	return createValidatedInstruction(
		[...operandExprs],
		run as any,
		ctx,
		`${plan.expression.name}(${plan.operands.length})`
	);
}
