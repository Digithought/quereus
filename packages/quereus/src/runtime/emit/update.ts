import type { UpdateNode } from '../../planner/nodes/update-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor, composeOldNewRow } from '../../util/row-descriptor.js';
import { withRowContextGenerator } from '../context-helpers.js';

export function emitUpdate(plan: UpdateNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Create row descriptor for the source rows (needed for assignment expression evaluation)
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());

	// Pre-calculate assignment column indices
	const assignmentTargetIndices = plan.assignments.map(assign => {
		const colNameLower = assign.targetColumn.name.toLowerCase();
		const tableColIdx = tableSchema.columnIndexMap.get(colNameLower);
		if (tableColIdx === undefined) {
			throw new QuereusError(`Column '${assign.targetColumn.name}' not found in table '${tableSchema.name}' during emitUpdate.`, StatusCode.INTERNAL);
		}
		return tableColIdx;
	});

	// Emit assignment value expressions as callbacks
	const assignmentEvaluators = plan.assignments.map(assign =>
		emitCallFromPlan(assign.value, ctx)
	);

	async function* run(rctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>, ...assignmentEvaluators: Array<(ctx: RuntimeContext) => SqlValue>): AsyncIterable<Row> {
		yield* withRowContextGenerator(rctx, sourceRowDescriptor, sourceRowsIterable, async function* (sourceRow) {
			// Evaluate assignment expressions in the context of this row
			const assignmentValues: SqlValue[] = [];
			for (const evaluator of assignmentEvaluators) {
				const value = evaluator(rctx) as SqlValue;
				assignmentValues.push(value);
			}

			// Create a new row with updated values
			const updatedRow = [...sourceRow]; // Copy the original row

			// Apply assignment values to the row
			for (let i = 0; i < assignmentValues.length; i++) {
				const targetColIdx = assignmentTargetIndices[i];
				updatedRow[targetColIdx] = assignmentValues[i];
			}

			// Create flat row with OLD (source) and NEW (updated) values for constraint checking
			const flatRow = composeOldNewRow(sourceRow, updatedRow, tableSchema.columns.length);

			// Yield the flat row for constraint checking
			// NOTE: UpdateNode only transforms rows - it does NOT execute the actual update
			// The UpdateExecutorNode is responsible for calling vtab.update
			yield flatRow;
		});
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...assignmentEvaluators],
		run: run as InstructionRun,
		note: `transformUpdateRows(${plan.table.tableSchema.name}, ${plan.assignments.length} cols)`
	};
}
