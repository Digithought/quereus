import type { DeleteNode } from '../../planner/nodes/delete-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import { getVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { extractOldRowFromFlat } from '../../util/row-descriptor.js';

const log = createLogger('runtime:emit:delete');
const errorLog = log.extend('error');
export function emitDelete(plan: DeleteNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Pre-calculate primary key column indices from schema
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

		// Always yield the deleted rows - consumers decide if they want them
	async function* run(ctx: RuntimeContext, flatRowsIterable: AsyncIterable<Row>): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, tableSchema);
		try {
			for await (const flatRow of flatRowsIterable) {
				// Extract OLD values from flat row (DELETE operations have OLD=actual data, NEW=NULL)
				const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);

				const keyValues: SqlValue[] = [];
				for (const pkColIdx of pkColumnIndicesInSchema) {
					if (pkColIdx >= oldRow.length) {
						throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in DELETE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
					}
					keyValues.push(oldRow[pkColIdx]);
				}

				// Yield the flat row for RETURNING to access OLD/NEW values
				yield flatRow;

				// Perform the deletion
				await vtab.xUpdate!('delete', undefined, keyValues);
			}
		} finally {
			await vtab.xDisconnect().catch((e: any) => errorLog(`Error during xDisconnect for ${tableSchema.name}: ${e}`));
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `delete(${plan.table.tableSchema.name})`
	};
}
