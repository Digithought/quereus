import type { UpdateNode } from '../../planner/nodes/update-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode, emitCall } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import { getVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:update');
const errorLog = log.extend('error');

export function emitUpdate(plan: UpdateNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Pre-calculate assignment column indices
	const assignmentTargetIndices = plan.assignments.map(assign => {
		const colNameLower = assign.targetColumn.name.toLowerCase();
		const tableColIdx = tableSchema.columnIndexMap.get(colNameLower);
		if (tableColIdx === undefined) {
			throw new QuereusError(`Column '${assign.targetColumn.name}' not found in table '${tableSchema.name}' during emitUpdate.`, StatusCode.INTERNAL);
		}
		return tableColIdx;
	});

	async function* processRow(sourceRow: Row, ...assignmentValues: Array<SqlValue>): AsyncIterable<Row> {
		// Create a new row with updated values
		const updatedRow = [...sourceRow]; // Copy the original row

		// Evaluate assignment expressions and update the row
		for (let i = 0; i < assignmentValues.length; i++) {
			const targetColIdx = assignmentTargetIndices[i];
			updatedRow[targetColIdx] = assignmentValues[i];
		}

		// For UPDATE operations, we need to provide both OLD and NEW row data to constraint checking
		// Store both in a special structure that constraint checking can access
		const updateRowData = {
			oldRow: sourceRow,
			newRow: updatedRow,
			isUpdateOperation: true
		};

		// Yield the updated row with attached old row metadata
		yield Object.assign([...updatedRow], { __updateRowData: updateRowData });
	}

	async function* runLogic(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>, ...assignmentValues: Array<SqlValue>): AsyncIterable<Row> {
		for await (const row of sourceRowsIterable) {
			for await (const updatedRow of processRow(row, ...assignmentValues)) {
				yield updatedRow;
			}
		}
	}

	async function run(ctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>, ...assignmentValues: Array<SqlValue>): Promise<AsyncIterable<Row>> {
		return runLogic(ctx, sourceRowsIterable, ...assignmentValues);
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const assignmentValueExprs = plan.assignments.map(assign => emitPlanNode(assign.value, ctx));

	return {
		params: [sourceInstruction, ...assignmentValueExprs],
		run: run as InstructionRun,
		note: `updateRows(${plan.table.tableSchema.name}, ${plan.assignments.length} cols)`
	};
}
