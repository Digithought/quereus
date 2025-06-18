import type { UpdateExecutorNode } from '../../planner/nodes/update-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import { getVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { extractOldRowFromFlat, extractNewRowFromFlat } from '../../util/row-descriptor.js';

const log = createLogger('runtime:emit:update-executor');
const errorLog = log.extend('error');

export function emitUpdateExecutor(plan: UpdateExecutorNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Pre-calculate primary key column indices from schema
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	async function executeUpdate(vtab: any, flatRow: Row): Promise<void> {
		// Extract OLD and NEW values from the flat row
		const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);
		const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);

		// Extract primary key values from the OLD row (these identify which row to update)
		const keyValues: SqlValue[] = [];
		for (const pkColIdx of pkColumnIndicesInSchema) {
			if (pkColIdx >= oldRow.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			keyValues.push(oldRow[pkColIdx]);
		}

		// Perform the actual update via xUpdate: update the row identified by keyValues to have the NEW values
		await vtab.xUpdate!('update', newRow, keyValues);
	}

	// Always yield the updated rows - consumers decide if they want them
	async function* run(ctx: RuntimeContext, flatRowsIterable: AsyncIterable<Row>): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, tableSchema);

		try {
			for await (const flatRow of flatRowsIterable) {
				await executeUpdate(vtab, flatRow);
				// Extract and yield the NEW row values
				const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);
				yield newRow;
			}
		} finally {
			await vtab.xDisconnect().catch((e: any) => errorLog(`Error during xDisconnect for ${tableSchema.name}: ${e}`));
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `executeUpdate(${plan.table.tableSchema.name})`
	};
}
