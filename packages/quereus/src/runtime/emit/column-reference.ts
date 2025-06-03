import type { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitColumnReference(plan: ColumnReferenceNode, ctx: EmissionContext): Instruction {
	function run(ctx: RuntimeContext): SqlValue {
		// Use deterministic lookup based on attribute ID
		for (const [descriptor, rowGetter] of ctx.context.entries()) {
			const columnIndex = descriptor[plan.attributeId];
			if (columnIndex !== undefined) {
				const row = rowGetter();
				if (Array.isArray(row) && columnIndex < row.length) {
					const value = row[columnIndex];
					return value;
				}
			}
		}

		throw new QuereusError(
			`No row context found for column ${plan.expression.name} (attr#${plan.attributeId}). The column reference must be evaluated within the context of its source relation.`,
			StatusCode.ERROR,
			undefined,
			plan.expression.loc?.start.line,
			plan.expression.loc?.start.column
		);
	}

	return {
		params: [],
		run,
		note: `column(${plan.expression.name})`
	};
}
