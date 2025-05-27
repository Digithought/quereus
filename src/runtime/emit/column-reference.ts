import type { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitColumnReference(plan: ColumnReferenceNode, ctx: EmissionContext): Instruction {
	function run(ctx: RuntimeContext): SqlValue {
		const rowGetter = ctx.context.get(plan.relationalNode);
		if (!rowGetter) {
			throw new QuereusError(
				`No row context found for column ${plan.expression.name}. The column reference must be evaluated within the context of its source relation.`,
				StatusCode.INTERNAL
			);
		}

		const row = rowGetter();
		if (!Array.isArray(row)) {
			throw new QuereusError(
				`Expected row array for column ${plan.expression.name}, got ${typeof row}`,
				StatusCode.INTERNAL
			);
		}

		if (plan.columnIndex >= row.length) {
			throw new QuereusError(
				`Column index ${plan.columnIndex} out of bounds for row with ${row.length} columns`,
				StatusCode.RANGE
			);
		}

		return row[plan.columnIndex];
	}

	return { params: [], run };
}
