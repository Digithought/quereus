import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitCall, emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type RuntimeValue, type SqlValue } from '../../common/types.js';
import { FunctionContext } from '../../func/context.js';
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
			resolvedFunctionSchema = found;
		}

		if (!resolvedFunctionSchema.xFunc) {
			throw new QuereusError(`Function ${functionName}/${numArgs} is not a scalar function`, StatusCode.ERROR);
		}

		// Create function context and call the function
		const funcCtx = new FunctionContext(ctx.db, resolvedFunctionSchema.userData);

		try {
			resolvedFunctionSchema.xFunc(funcCtx, args);

			// Get the result from the context
			const error = funcCtx._getError();
			if (error) {
				throw error;
			}

			return funcCtx._getResult();
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
