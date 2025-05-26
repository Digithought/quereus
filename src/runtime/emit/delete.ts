import type { DeleteNode } from '../../planner/nodes/delete-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import { getVTable } from '../utils.js';
import type { TableSchema } from '../../schema/table.js';
import { isAsyncIterable } from '../utils.js';

export function emitDelete(plan: DeleteNode): Instruction {
	const sourceInstruction = emitPlanNode(plan.source);
	const tableSchema = plan.table.tableSchema;
	// DeleteNode is now a VoidNode by default; only RETURNING wraps it in ProjectNode
	const isReturning = false;

	// Pre-calculate primary key column indices from schema
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	async function* processAndDeleteRow(vtab: any, sourceRow: Row): AsyncIterable<Row> {
		const keyValues: SqlValue[] = [];
		for (const pkColIdx of pkColumnIndicesInSchema) {
			if (pkColIdx >= sourceRow.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for source row length ${sourceRow.length} in DELETE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			keyValues.push(sourceRow[pkColIdx]);
		}

		// For DELETE, `values` is undefined, `oldKeyValues` identifies the row.
		const valuesForXUpdate: undefined = undefined;

		if (isReturning) {
			yield sourceRow; // Yield the row *before* deletion for RETURNING
		}

		await vtab.xUpdate!('delete', valuesForXUpdate, keyValues);
	}

	async function* runLogic(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, tableSchema);
		try {
			for await (const row of sourceRowsIterable) {
				for await (const returningRow of processAndDeleteRow(vtab, row)) {
					yield returningRow;
				}
			}
		} finally {
			await vtab.xDisconnect().catch((e: any) => console.error(`Error during xDisconnect for ${tableSchema.name}: ${e}`));
		}
	}

	async function run(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>): Promise<AsyncIterable<Row> | SqlValue | undefined> {
		const resultsIterable = runLogic(ctx, sourceRowsIterable);
		if (isReturning) {
			return resultsIterable;
		} else {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _ of resultsIterable) { /* Consume */ }
			return undefined;
		}
	}

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `delete(${plan.table.tableSchema.name})`
	};
}
