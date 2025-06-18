import type { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:context:lookup');

export function emitColumnReference(plan: ColumnReferenceNode, _ctx: EmissionContext): Instruction {
	function run(rctx: RuntimeContext): SqlValue {
		log('Looking up column %s (attr#%d)', plan.expression.name, plan.attributeId);

		// Log available contexts for debugging
		const availableContexts: string[] = [];
		for (const [descriptor] of rctx.context.entries()) {
			const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
			availableContexts.push(`[attrs: ${attrs.join(',')}]`);
		}
		log('Available contexts: %O', availableContexts);

		// Use deterministic lookup based on attribute ID
		for (const [descriptor, rowGetter] of rctx.context.entries()) {
			const columnIndex = descriptor[plan.attributeId];
			if (columnIndex !== undefined) {
				const row = rowGetter();
				if (Array.isArray(row) && columnIndex < row.length) {
					const value = row[columnIndex];
					log('Successfully resolved %s (attr#%d) to value: %O from row: %O at index %d', plan.expression.name, plan.attributeId, value, row, columnIndex);
					return value;
				}
			}
		}

		log('Failed to resolve %s (attr#%d) - no matching context found', plan.expression.name, plan.attributeId);
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
