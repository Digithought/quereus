import type { DeleteNode } from '../../planner/nodes/delete-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import { getVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:delete');
const errorLog = log.extend('error');
export function emitDelete(plan: DeleteNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Pre-calculate primary key column indices from schema
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	// Always yield the deleted rows - consumers decide if they want them
	async function* run(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, tableSchema);
		try {
			for await (const sourceRow of sourceRowsIterable) {
				const keyValues: SqlValue[] = [];
				for (const pkColIdx of pkColumnIndicesInSchema) {
					if (pkColIdx >= sourceRow.length) {
						throw new QuereusError(`PK column index ${pkColIdx} out of bounds for source row length ${sourceRow.length} in DELETE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
					}
					keyValues.push(sourceRow[pkColIdx]);
				}

				// Yield the row *before* deletion for RETURNING
				yield sourceRow;

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
