import type { UpdateExecutorNode } from '../../planner/nodes/update-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import { getVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:update-executor');
const errorLog = log.extend('error');

export function emitUpdateExecutor(plan: UpdateExecutorNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Pre-calculate primary key column indices from schema
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	async function executeUpdate(vtab: any, updatedRow: Row): Promise<void> {
		// For UPDATE operations, we need the OLD row's primary key values to identify which row to update
		// The NEW row values are what we're updating TO
		const oldRowKeyValues = (updatedRow as any).__oldRowKeyValues;

		if (!oldRowKeyValues) {
			throw new QuereusError(`Missing OLD row key values for UPDATE on '${tableSchema.name}'. Expected from ConstraintCheck.`, StatusCode.INTERNAL);
		}

		// Extract primary key values from the OLD row (these identify which row to update)
		const keyValues: SqlValue[] = [];
		for (const pkColIdx of pkColumnIndicesInSchema) {
			if (pkColIdx >= oldRowKeyValues.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRowKeyValues.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			keyValues.push(oldRowKeyValues[pkColIdx]);
		}

		// Perform the actual update via xUpdate: update the row identified by keyValues to have the values in updatedRow
		await vtab.xUpdate!('update', updatedRow, keyValues);
	}

	async function run(ctx: RuntimeContext, updatedRowsIterable: AsyncIterable<Row>): Promise<SqlValue | undefined> {
		const vtab = await getVTable(ctx, tableSchema);

		try {
			for await (const updatedRow of updatedRowsIterable) {
				await executeUpdate(vtab, updatedRow);
			}
		} finally {
			await vtab.xDisconnect().catch((e: any) => errorLog(`Error during xDisconnect for ${tableSchema.name}: ${e}`));
		}

		return undefined;
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `executeUpdate(${plan.table.tableSchema.name})`
	};
}
