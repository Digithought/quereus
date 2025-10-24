import type { DmlExecutorNode } from '../../planner/nodes/dml-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { getVTable, disconnectVTable } from '../utils.js';
import { ConflictResolution } from '../../common/constants.js';
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
				await vtab.update!('insert', newRow, undefined, plan.onConflict ?? ConflictResolution.ABORT);
				// Track change (INSERT): record NEW primary key
				const pkValues = tableSchema.primaryKeyDefinition.map(def => newRow[def.index]);
				ctx.db._recordInsert(`${tableSchema.schemaName}.${tableSchema.name}`, pkValues);
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
				const keyValues: SqlValue[] = pkColumnIndicesInSchema.map(pkColIdx => {
					if (pkColIdx >= oldRow.length) {
						throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
					}
					return oldRow[pkColIdx];
				});
				await vtab.update!('update', newRow, keyValues, ConflictResolution.ABORT);
				// Track change (UPDATE): record OLD and NEW primary keys
				const newKeyValues: SqlValue[] = tableSchema.primaryKeyDefinition.map(pkColDef => newRow[pkColDef.index]);
				ctx.db._recordUpdate(`${tableSchema.schemaName}.${tableSchema.name}`, keyValues, newKeyValues);
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

				const keyValues: SqlValue[] = pkColumnIndicesInSchema.map(pkColIdx => {
					if (pkColIdx >= oldRow.length) {
						throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in DELETE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
					}
					return oldRow[pkColIdx];
				});
				await vtab.update!('delete', undefined, keyValues, ConflictResolution.ABORT);
				// Track change (DELETE): record OLD primary key
				ctx.db._recordDelete(`${tableSchema.schemaName}.${tableSchema.name}`, keyValues);
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
