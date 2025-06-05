import type { AddConstraintNode } from '../../planner/nodes/add-constraint-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { RowConstraintSchema } from '../../schema/table.js';
import { opsToMask } from '../../schema/table.js';

const log = createLogger('runtime:emit:add-constraint');

export function emitAddConstraint(plan: AddConstraintNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Convert the AST constraint to a schema constraint object
		const constraint = plan.constraint;

		if (constraint.type !== 'check') {
			throw new QuereusError(
				`ADD CONSTRAINT ${constraint.type} is not yet implemented`,
				StatusCode.UNSUPPORTED
			);
		}

		if (!constraint.expr) {
			throw new QuereusError(
				'CHECK constraint requires an expression',
				StatusCode.ERROR
			);
		}

		// Create the constraint schema object
		const constraintSchema: RowConstraintSchema = {
			name: constraint.name || `check_${tableSchema.checkConstraints.length}`,
			expr: constraint.expr,
			operations: opsToMask(constraint.operations), // Convert operations array to bitmask
		};

		// Add the constraint to the table schema by creating a new frozen array
		const updatedConstraints = [...tableSchema.checkConstraints, constraintSchema];
		(tableSchema as any).checkConstraints = Object.freeze(updatedConstraints);

		log('Added constraint %s to table %s', constraintSchema.name, tableSchema.name);

		return null;
	}

	return {
		params: [],
		run: run as InstructionRun,
		note: `addConstraint(${plan.table.tableSchema.name}, ${plan.constraint.name || 'unnamed'})`
	};
}
