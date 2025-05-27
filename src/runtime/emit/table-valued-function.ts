import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { FunctionSchema } from '../../schema/function.js';
import type { EmissionContext } from '../emission-context.js';

/**
 * Represents a table-valued function call in a plan node.
 * This would be a new plan node type for TVFs.
 */
export interface TableValuedFunctionCallNode {
	nodeType: 'TableValuedFunctionCall';
	functionName: string;
	operands: any[]; // ScalarPlanNode[]
}

export function emitTableValuedFunctionCall(plan: TableValuedFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionName = plan.functionName.toLowerCase();
	const numArgs = plan.operands.length;

	// Look up the function during emission and record the dependency
	const functionSchema = ctx.findFunction(functionName, numArgs);
	if (!functionSchema) {
		throw new QuereusError(`Unknown function: ${functionName}/${numArgs}`, StatusCode.ERROR);
	}
	if (functionSchema.type !== 'table-valued' || !functionSchema.tableValuedImpl) {
		throw new QuereusError(`Function ${functionName}/${numArgs} is not a table-valued function`, StatusCode.ERROR);
	}

	// Capture the function key for runtime retrieval
	const functionKey = `function:${functionName}/${numArgs}`;

	async function* run(runtimeCtx: RuntimeContext, ...args: Array<SqlValue>): AsyncIterable<Row> {
		// Use the captured function schema instead of doing a fresh lookup
		const capturedFunction = ctx.getCapturedSchemaObject<FunctionSchema>(functionKey);
		if (!capturedFunction) {
			throw new QuereusError(`Function ${functionName}/${numArgs} was not captured during emission`, StatusCode.INTERNAL);
		}

		// Validate argument count
		if (capturedFunction.numArgs >= 0 && args.length !== capturedFunction.numArgs) {
			throw new QuereusError(`Function ${functionName} called with ${args.length} arguments, expected ${capturedFunction.numArgs}`, StatusCode.ERROR);
		}

		try {
			const result = capturedFunction.tableValuedImpl!(...args);
			// Handle both direct AsyncIterable and Promise<AsyncIterable>
			const iterable = result instanceof Promise ? await result : result;

			for await (const row of iterable) {
				yield row;
			}
		} catch (error: any) {
			throw new QuereusError(`Table-valued function ${functionName} failed: ${error.message}`, StatusCode.ERROR, error);
		}
	}

	const operandExprs = plan.operands.map(operand => emitPlanNode(operand, ctx));

	return createValidatedInstruction(
		[...operandExprs],
		run as any,
		ctx,
		`TVF:${plan.functionName}(${plan.operands.length})`
	);
}
