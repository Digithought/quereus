import type { UpdateNode } from '../../planner/nodes/update-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import { getVTable } from '../utils.js';

export function emitUpdate(plan: UpdateNode): Instruction {
	const sourceInstruction = emitPlanNode(plan.source);
	const assignmentValueInstructions = plan.assignments.map(assign => emitPlanNode(assign.value));
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

	async function* processAndUpdateRow(vtab: any, sourceRow: Row, assignmentSqlValues: SqlValue[]): AsyncIterable<Row> {
		const oldKeyValues: SqlValue[] = [];

		for (const pkColIdx of pkColumnIndicesInSchema) {
			if (pkColIdx >= sourceRow.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for source row length ${sourceRow.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			oldKeyValues.push(sourceRow[pkColIdx]);
		}

		const newCompleteRow: SqlValue[] = [...sourceRow];
		// let keyMightHaveChanged = false; // Not directly used in this simplified xUpdate call

		assignmentTargetIndices.forEach((tableColIdx, i) => {
			newCompleteRow[tableColIdx] = assignmentSqlValues[i];
			// if (tableSchema.primaryKey?.includes(tableSchema.columns[tableColIdx].name)) {
			//   keyMightHaveChanged = true;
			// }
		});

		(newCompleteRow as any)._onConflict = plan.onConflict || 'abort';
		await vtab.xUpdate!('update', newCompleteRow, oldKeyValues);

		if (isReturning) {
			yield newCompleteRow;
		}
	}

	async function* runLogic(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>, ...assignmentSqlValues: SqlValue[]): AsyncIterable<Row> {
		const vtab = await getVTable(ctx, plan.table.tableSchema);
		try {
			for await (const row of sourceRowsIterable) {
				for await (const returningRow of processAndUpdateRow(vtab, row, assignmentSqlValues)) {
					yield returningRow;
				}
			}
		} finally {
			await vtab.xDisconnect().catch((e: any) => console.error(`Error during xDisconnect for ${tableSchema.name}: ${e}`));
		}
	}

	async function run(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>, ...assignmentSqlValues: SqlValue[]): Promise<AsyncIterable<Row> | SqlValue | undefined> {
		const resultsIterable = runLogic(ctx, sourceRowsIterable, ...assignmentSqlValues);
		if (isReturning) {
			return resultsIterable;
		} else {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _ of resultsIterable) { /* Consume */ }
			return undefined;
		}
	}

	return { params: [sourceInstruction, ...assignmentValueInstructions], run: run as InstructionRun };
}
