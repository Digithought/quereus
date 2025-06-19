import type { InsertNode } from '../../planner/nodes/insert-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { SqlDataType, type SqlValue } from '../../common/types.js';
import { applyIntegerAffinity, applyRealAffinity, applyNumericAffinity, applyTextAffinity, applyBlobAffinity } from '../../util/affinity.js';

export function emitInsert(plan: InsertNode, ctx: EmissionContext): Instruction {
	// INSERT node now only handles data transformations and passes flat rows through.
	// The actual database insert operations are handled by DmlExecutorNode.
	async function* run(_ctx: RuntimeContext, sourceValue: AsyncIterable<Row>): AsyncIterable<Row> {
		const tableSchema = plan.table.tableSchema;
		const colCount = tableSchema.columns.length;

		for await (const sourceRow of sourceValue) {
			// Convert source row to flat OLD/NEW format
			// For INSERT: OLD values are all NULL, NEW values are from source
			const flatRow: Row = new Array(colCount * 2);

			// Fill OLD section with NULLs (indices 0..n-1)
			for (let i = 0; i < colCount; i++) {
				flatRow[i] = null;
			}

			// Fill NEW section with source values and apply type affinity (indices n..2n-1)
			for (let colIdx = 0; colIdx < colCount; colIdx++) {
				const sourceValue: SqlValue = sourceRow[colIdx];

				let converted: SqlValue;
				switch (tableSchema.columns[colIdx].affinity) {
					case SqlDataType.INTEGER: converted = applyIntegerAffinity(sourceValue); break;
					case SqlDataType.REAL: converted = applyRealAffinity(sourceValue); break;
					case SqlDataType.NUMERIC: converted = applyNumericAffinity(sourceValue); break;
					case SqlDataType.TEXT: converted = applyTextAffinity(sourceValue); break;
					case SqlDataType.BLOB: converted = applyBlobAffinity(sourceValue); break;
					default: converted = sourceValue;
				}

				flatRow[colCount + colIdx] = converted;
			}

			yield flatRow;
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `insertPrep(${plan.table.tableSchema.name})`
	};
}
