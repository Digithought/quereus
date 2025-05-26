import type { ParameterReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { SqlValue } from '../../common/types.js';

export function emitParameterReference(plan: ParameterReferenceNode): Instruction {
	function run(ctx: RuntimeContext): SqlValue {
		const identifier = plan.nameOrIndex; // This comes from the ParameterReferenceNode instance

		if (ctx.params === undefined) {
			throw new QuereusError('Query executed with parameters, but no parameter values were provided.', StatusCode.MISUSE);
		}

		if (typeof identifier === 'number') {
			// For ? (anonymous) parameters, identifier is a 1-based index.
			// SqlParameters can be an array or an object.
			if (Array.isArray(ctx.params)) {
				if (identifier < 1 || identifier > ctx.params.length) {
					throw new QuereusError(`Parameter index ${identifier} is out of bounds.`, StatusCode.RANGE);
				}
				return ctx.params[identifier - 1];
			} else if (typeof ctx.params === 'object' && ctx.params !== null) {
				// Support numbered parameters like :1, :2 in an object (e.g., { "1": value })
				const key = String(identifier);
				if (!(key in ctx.params)) {
					throw new QuereusError(`Parameter with index ${identifier} not found in provided object.`, StatusCode.NOTFOUND);
				}
				return ctx.params[key as keyof typeof ctx.params];
			} else {
				throw new QuereusError('Parameters provided in an unsupported format for indexed access.', StatusCode.MISUSE);
			}
		} else if (typeof identifier === 'string') {
			// For named parameters like :name.
			if (Array.isArray(ctx.params)) {
				throw new QuereusError('Named parameter found in query, but parameters provided as an array.', StatusCode.MISUSE);
			}
			if (typeof ctx.params === 'object' && ctx.params !== null) {
				const key = identifier.startsWith(':') ? identifier.substring(1) : identifier;
				if (!(key in ctx.params)) {
					throw new QuereusError(`Parameter with name '${key}' not found.`, StatusCode.NOTFOUND);
				}
				return ctx.params[key as keyof typeof ctx.params];
			} else {
				throw new QuereusError('Parameters provided in an unsupported format for named access.', StatusCode.MISUSE);
			}
		} else {
			// Should not happen given ParameterReferenceNode structure
			throw new QuereusError('Invalid parameter identifier type.', StatusCode.INTERNAL);
		}
	}

	return {
		params: [],
		run,
		note: `param(${typeof plan.nameOrIndex === 'string' ? plan.nameOrIndex : '#' + plan.nameOrIndex})`
	};
}
