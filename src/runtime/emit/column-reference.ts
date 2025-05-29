import type { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitColumnReference(plan: ColumnReferenceNode, ctx: EmissionContext): Instruction {
	function run(ctx: RuntimeContext): SqlValue {
		// For now, try to find any row context (for backward compatibility during transition)
		// In a full implementation, we'd have a mapping from attribute IDs to row contexts
		const contexts = Array.from(ctx.context.keys());
		const rowContext = contexts.find(key => typeof key === 'object');
		if (rowContext) {
			const rowGetter = ctx.context.get(rowContext);
			if (rowGetter) {
				const row = rowGetter();
				if (Array.isArray(row) && plan.columnIndex < row.length) {
					return row[plan.columnIndex];
				}
			}
		}

		throw new QuereusError(
			`No row context found for column ${plan.expression.name} (attr#${plan.attributeId}). The column reference must be evaluated within the context of its source relation.`,
			StatusCode.INTERNAL
		);
	}

	return {
		params: [],
		run,
		note: `column(${plan.expression.name})`
	};
}
