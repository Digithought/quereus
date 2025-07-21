import type { DmlExecutorNode } from '../../planner/nodes/dml-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type Row } from '../../common/types.js';
import { getVTable, disconnectVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { extractOldRowFromFlat, extractNewRowFromFlat } from '../../util/row-descriptor.js';

export function emitDmlExecutor(plan: DmlExecutorNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Pre-calculate primary key column indices from schema (needed for update/delete)
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	// --- Operation-specific run generators ------------------------------------

	// INSERT ----------------------------------------------------
	async function* runInsert(ctx: RuntimeContext, rows: AsyncIterable<Row>): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, tableSchema);
		try {
			for await (const flatRow of rows) {
				const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);
				// TODO: Remove this monkey patch
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(newRow as any)._onConflict = plan.onConflict || 'abort';
				await vtab.xUpdate!('insert', newRow);
				yield flatRow; // make OLD/NEW available downstream (e.g. RETURNING)
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// UPDATE ----------------------------------------------------
	async function* runUpdate(ctx: RuntimeContext, rows: AsyncIterable<Row>): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, tableSchema);
		try {
			for await (const flatRow of rows) {
				const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);
				const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);

				// Extract primary key values from the OLD row (these identify which row to update)
				const keyValues = pkColumnIndicesInSchema.map(pkColIdx => {
					if (pkColIdx >= oldRow.length) {
						throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
					}
					return oldRow[pkColIdx];
				});
				await vtab.xUpdate!('update', newRow, keyValues);
				yield flatRow;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// DELETE ----------------------------------------------------
	async function* runDelete(ctx: RuntimeContext, rows: AsyncIterable<Row>): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, tableSchema);
		try {
			for await (const flatRow of rows) {
				const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);

				const keyValues = pkColumnIndicesInSchema.map(pkColIdx => {
					if (pkColIdx >= oldRow.length) {
						throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in DELETE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
					}
					return oldRow[pkColIdx];
				});
				await vtab.xUpdate!('delete', undefined, keyValues);
				yield flatRow;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// Select the correct generator based on operation
	let run: InstructionRun;
	switch (plan.operation) {
		case 'insert': run = runInsert as InstructionRun; break;
		case 'update': run = runUpdate as InstructionRun; break;
		case 'delete': run = runDelete as InstructionRun; break;
		default:
			throw new QuereusError(`Unknown DML operation: ${plan.operation}`, StatusCode.INTERNAL);
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run,
		note: `execute${plan.operation}(${plan.table.tableSchema.name})`
	};
}
