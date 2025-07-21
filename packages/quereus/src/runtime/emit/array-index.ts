import type { ArrayIndexNode } from '../../planner/nodes/array-index-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode, type OutputValue } from '../../common/types.js';

export function emitArrayIndex(plan: ArrayIndexNode, _ctx: EmissionContext): Instruction {
	function run(ctx: RuntimeContext): OutputValue {
		// Look through the context to find a row that has the index we need
		for (const [_descriptor, rowGetter] of ctx.context.entries()) {
			const row = rowGetter();
			if (Array.isArray(row) && plan.index < row.length) {
				return row[plan.index];
			}
		}

		quereusError(`No row context found for array index ${plan.index}`, StatusCode.INTERNAL);
	}

	return {
		params: [],
		run: run,
		note: `array[${plan.index}]`
	};
}
