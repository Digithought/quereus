import type { UpdateNode } from '../../planner/nodes/update-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode, emitCall } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import { getVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';

export function emitUpdate(plan: UpdateNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;
	// UpdateNode is now a VoidNode by default; only RETURNING wraps it in ProjectNode
	const isReturning = false;

	// Pre-calculate assignment column indices
	const assignmentTargetIndices = plan.assignments.map(assign => {
		const colNameLower = assign.targetColumn.name.toLowerCase();
		const tableColIdx = tableSchema.columnIndexMap.get(colNameLower);
		if (tableColIdx === undefined) {
			throw new QuereusError(`Column '${assign.targetColumn.name}' not found in table '${tableSchema.name}' during emitUpdate.`, StatusCode.INTERNAL);
		}
		return tableColIdx;
	});

	// Pre-calculate primary key column indices from schema (used if sourceRow doesn't guarantee PKs first)
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	async function* processAndUpdateRow(vtab: any, sourceRow: Row, ...assignmentValues: Array<SqlValue>): AsyncIterable<Row> {
		// Extract primary key values from the source row
		const keyValues: SqlValue[] = [];
		for (const pkColIdx of pkColumnIndicesInSchema) {
			if (pkColIdx >= sourceRow.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for source row length ${sourceRow.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			keyValues.push(sourceRow[pkColIdx]);
		}

		// Create a new row with updated values
		const updatedRow = [...sourceRow]; // Copy the original row

		// Evaluate assignment expressions and update the row
		for (let i = 0; i < assignmentValues.length; i++) {
			const targetColIdx = assignmentTargetIndices[i];
			updatedRow[targetColIdx] = assignmentValues[i];
		}

		if (isReturning) {
			yield updatedRow; // Yield the updated row for RETURNING
		}

		// Perform the actual update via xUpdate
		await vtab.xUpdate!('update', updatedRow, keyValues);
	}

	async function* runLogic(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>, ...assignmentValues: Array<SqlValue>): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, tableSchema);

		try {
			for await (const row of sourceRowsIterable) {
				for await (const returningRow of processAndUpdateRow(vtab, row, ...assignmentValues)) {
					yield returningRow; // Only yields if RETURNING is active
				}
			}
		} finally {
			await vtab.xDisconnect().catch((e: any) => console.error(`Error during xDisconnect for ${tableSchema.name}: ${e}`));
		}
	}

	async function run(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>, ...assignmentValues: Array<SqlValue>): Promise<AsyncIterable<Row> | SqlValue | undefined> {
		const resultsIterable = runLogic(ctx, sourceRowsIterable, ...assignmentValues);
		if (isReturning) {
			return resultsIterable;
		} else {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _ of resultsIterable) { /* Consume */ }
			return undefined;
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const assignmentValueExprs = plan.assignments.map(assign => emitPlanNode(assign.value, ctx));

	return {
		params: [sourceInstruction, ...assignmentValueExprs],
		run: run as InstructionRun,
		note: `update(${plan.table.tableSchema.name}, ${plan.assignments.length} cols)`
	};
}
