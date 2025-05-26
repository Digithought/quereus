import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { FunctionSchema } from '../../schema/function.js';

/**
 * Represents a table-valued function call in a plan node.
 * This would be a new plan node type for TVFs.
 */
export interface TableValuedFunctionCallNode {
	nodeType: 'TableValuedFunctionCall';
	functionName: string;
	operands: any[]; // ScalarPlanNode[]
}

export function emitTableValuedFunctionCall(plan: TableValuedFunctionCallNode): Instruction {
	const operandExprs = plan.operands.map(operand => emitPlanNode(operand));
	const functionName = plan.functionName.toLowerCase();
	const numArgs = plan.operands.length;

	let resolvedFunctionSchema: FunctionSchema | null = null;

	async function* run(ctx: RuntimeContext, ...args: Array<SqlValue>): AsyncIterable<Row> {
		// Resolve function on first call and cache it
		if (!resolvedFunctionSchema) {
			const found = ctx.db._findFunction(functionName, numArgs);
			if (!found) {
				throw new QuereusError(`Unknown function: ${functionName}/${numArgs}`, StatusCode.ERROR);
			}
			if (found.type !== 'table-valued' || !found.tableValuedImpl) {
				throw new QuereusError(`Function ${functionName}/${numArgs} is not a table-valued function`, StatusCode.ERROR);
			}
			resolvedFunctionSchema = found;
		}

		// Validate argument count
		if (resolvedFunctionSchema.numArgs >= 0 && args.length !== resolvedFunctionSchema.numArgs) {
			throw new QuereusError(`Function ${functionName} called with ${args.length} arguments, expected ${resolvedFunctionSchema.numArgs}`, StatusCode.ERROR);
		}

		try {
			const result = resolvedFunctionSchema.tableValuedImpl!(...args);
			// Handle both direct AsyncIterable and Promise<AsyncIterable>
			const iterable = result instanceof Promise ? await result : result;

			for await (const row of iterable) {
				yield row;
			}
		} catch (error: any) {
			throw new QuereusError(`Table-valued function ${functionName} failed: ${error.message}`, StatusCode.ERROR, error);
		}
	}

	return {
		params: [...operandExprs],
		run: run as any,
		note: `TVF:${plan.functionName}(${plan.operands.length})`
	};
}
