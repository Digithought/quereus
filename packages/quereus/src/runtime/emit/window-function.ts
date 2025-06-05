import type { WindowFunctionCallNode } from '../../planner/nodes/window-function.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export function emitWindowFunctionCall(plan: WindowFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionName = plan.functionName.toLowerCase();

	if (functionName === 'row_number') {
		// For ROW_NUMBER(), use a simple counter that resets for each query execution
		let rowCounter = 0;

		function run(rctx: RuntimeContext): SqlValue {
			return ++rowCounter;
		}

		return {
			params: [],
			run,
			note: `windowFunctionCall(${plan.functionName})`
		};
	}

	if (functionName === 'rank' || functionName === 'dense_rank') {
		// For RANK() and DENSE_RANK(), use simple counter for now
		let rowCounter = 0;

		function run(rctx: RuntimeContext): SqlValue {
			return ++rowCounter;
		}

		return {
			params: [],
			run,
			note: `windowFunctionCall(${plan.functionName})`
		};
	}

	throw new QuereusError(`Window function '${plan.functionName}' not yet implemented`, StatusCode.UNSUPPORTED);
}
