import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { FunctionSchema, IntegratedTableValuedFunc, TableValuedFunc } from '../../schema/function.js';
import type { EmissionContext } from '../emission-context.js';
import type { TableFunctionCallNode } from '../../planner/nodes/table-function-call.js';

export function emitTableValuedFunctionCall(plan: TableFunctionCallNode, ctx: EmissionContext): Instruction {
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

	async function* runIntegrated(innerCtx: RuntimeContext, ...args: Array<SqlValue>): AsyncIterable<Row> {
		// Use the captured function schema instead of doing a fresh lookup
		const capturedFunction = ctx.getCapturedSchemaObject<FunctionSchema>(functionKey);
		if (!capturedFunction) {
			throw new QuereusError(`Function ${functionName}/${numArgs} was not captured during emission`, StatusCode.INTERNAL);
		}

		try {
			// Check if this is a database-aware function
			const result = (capturedFunction.tableValuedImpl as IntegratedTableValuedFunc)!(innerCtx.db, ...args);

			// Handle both direct AsyncIterable and Promise<AsyncIterable>
			const iterable = result instanceof Promise ? await result : result;

			for await (const row of iterable) {
				yield row;
			}
		} catch (error: any) {
			throw new QuereusError(`Table-valued function ${functionName} failed: ${error.message}`, StatusCode.ERROR, error);
		}
	}

	async function* run(innerCtx: RuntimeContext, ...args: Array<SqlValue>): AsyncIterable<Row> {
		// Use the captured function schema instead of doing a fresh lookup
		const capturedFunction = ctx.getCapturedSchemaObject<FunctionSchema>(functionKey);
		if (!capturedFunction) {
			throw new QuereusError(`Function ${functionName}/${numArgs} was not captured during emission`, StatusCode.INTERNAL);
		}

		try {
			// Check if this is a database-aware function
			const result = (capturedFunction.tableValuedImpl as TableValuedFunc)!(...args);

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
		(functionSchema.isIntegrated ? runIntegrated : run) as InstructionRun,
		ctx,
		`TVF:${plan.functionName}(${plan.operands.length})`
	);
}
