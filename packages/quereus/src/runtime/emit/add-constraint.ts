import type { AddConstraintNode } from '../../planner/nodes/add-constraint-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import { opsToMask } from '../../schema/table.js';

const log = createLogger('runtime:emit:add-constraint');

export function emitAddConstraint(plan: AddConstraintNode, _ctx: EmissionContext): Instruction {
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
		// Note: We don't validate determinism here because constraints may reference NEW/OLD
		// which require special scoping. Determinism is validated at INSERT/UPDATE plan time
		// in constraint-builder.ts when the constraint is actually checked.
		const constraintSchema: RowConstraintSchema = {
			name: constraint.name || `check_${tableSchema.checkConstraints.length}`,
			expr: constraint.expr,
			operations: opsToMask(constraint.operations), // Convert operations array to bitmask
			deferrable: constraint.deferrable ?? false,
			initiallyDeferred: constraint.initiallyDeferred,
		};

		// Create a new table schema with the additional constraint (honor immutability)
		const updatedConstraints = [...tableSchema.checkConstraints, constraintSchema];
		const updatedTableSchema: TableSchema = {
			...tableSchema,
			checkConstraints: Object.freeze(updatedConstraints),
		};

		// Replace the table schema in the database
		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getSchemaOrFail(tableSchema.schemaName);

		// Replace the table schema (addTable overwrites existing)
		schema.addTable(updatedTableSchema);

		// Notify schema change listeners that the table was modified
		schemaManager.getChangeNotifier().notifyChange({
			type: 'table_modified',
			schemaName: tableSchema.schemaName,
			objectName: tableSchema.name,
			oldObject: tableSchema,
			newObject: updatedTableSchema
		});

		log('Added constraint %s to table %s.%s', constraintSchema.name, tableSchema.schemaName, tableSchema.name);

		return null;
	}

	return {
		params: [],
		run: run as InstructionRun,
		note: `addConstraint(${plan.table.tableSchema.name}, ${plan.constraint.name || 'unnamed'})`
	};
}
