import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitCall, emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type RuntimeValue, type SqlValue } from '../../common/types.js';
import type { FunctionSchema } from '../../schema/function.js';

export function emitScalarFunctionCall(plan: ScalarFunctionCallNode): Instruction {
	const operandExprs = plan.operands.map(operand => emitPlanNode(operand));
	const functionName = plan.expression.name.toLowerCase();
	const numArgs = plan.operands.length;

	// TODO: Introduce emitter context, and look up the function outside of the run function

	let resolvedFunctionSchema: FunctionSchema | null = null;

	async function run(ctx: RuntimeContext, ...args: Array<SqlValue>): Promise<SqlValue> {
		// Resolve function on first call and cache it
		if (!resolvedFunctionSchema) {
			const found = ctx.db._findFunction(functionName, numArgs);
			if (!found) {
				throw new QuereusError(`Unknown function: ${functionName}/${numArgs}`, StatusCode.ERROR);
			}
			if (found.type !== 'scalar') {
				throw new QuereusError(`Function ${functionName}/${numArgs} is not a scalar function`, StatusCode.ERROR);
			}
			resolvedFunctionSchema = found;
		}

		// Validate argument count
		if (resolvedFunctionSchema.numArgs >= 0 && args.length !== resolvedFunctionSchema.numArgs) {
			throw new QuereusError(`Function ${functionName} called with ${args.length} arguments, expected ${resolvedFunctionSchema.numArgs}`, StatusCode.ERROR);
		}

		// Use the direct implementation
		if (!resolvedFunctionSchema.scalarImpl) {
			throw new QuereusError(`Function ${functionName}/${numArgs} has no implementation`, StatusCode.ERROR);
		}

		try {
			const result = resolvedFunctionSchema.scalarImpl(...args);
			// Handle both sync and async results
			return result instanceof Promise ? await result : result;
		} catch (error: any) {
			throw new QuereusError(`Function ${functionName} failed: ${error.message}`, StatusCode.ERROR, error);
		}
	}

	return {
		params: [...operandExprs],
		run: run as any,
		note: `${plan.expression.name}(${plan.operands.length})`
	};
}
