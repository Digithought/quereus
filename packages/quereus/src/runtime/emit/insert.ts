import type { InsertNode } from '../../planner/nodes/insert-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row, SqlDataType } from '../../common/types.js';
import { getVTable, disconnectVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { applyIntegerAffinity, applyRealAffinity, applyNumericAffinity, applyTextAffinity, applyBlobAffinity } from '../../util/affinity.js';
import { extractNewRowFromFlat } from '../../util/row-descriptor.js';

export function emitInsert(plan: InsertNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

			// This function processes a single row and conditionally yields it for RETURNING
	async function* processAndYieldRow(vtab: any, flatRow: Row): AsyncIterable<Row> {
		// Extract NEW values from flat row (INSERT operations have OLD=NULL, NEW=actual values)
		const rowToInsert = extractNewRowFromFlat(flatRow, tableSchema.columns.length);
		const valuesForXUpdate: SqlValue[] = new Array(tableSchema.columns.length + 1).fill(null);
		valuesForXUpdate[0] = null; // Placeholder for key, null for INSERT with xUpdate

		// With orthogonal row expansion, the row should now match the table structure exactly
		if (rowToInsert.length !== tableSchema.columns.length) {
			throw new QuereusError(`Column count mismatch for INSERT into '${tableSchema.name}'. Expected ${tableSchema.columns.length}, got ${rowToInsert.length} (orthogonal row expansion should ensure this matches).`, StatusCode.ERROR);
		}

		// Map each column from the expanded row to the xUpdate values array
		tableSchema.columns.forEach((columnSchema: any, tableColIdx: number) => {
			const rawValue = rowToInsert[tableColIdx];

			// Apply type affinity conversion based on column's declared affinity
			let convertedValue: SqlValue;
			switch (columnSchema.affinity) {
				case SqlDataType.INTEGER:
					convertedValue = applyIntegerAffinity(rawValue);
					break;
				case SqlDataType.REAL:
					convertedValue = applyRealAffinity(rawValue);
					break;
				case SqlDataType.NUMERIC:
					convertedValue = applyNumericAffinity(rawValue);
					break;
				case SqlDataType.TEXT:
					convertedValue = applyTextAffinity(rawValue);
					break;
				case SqlDataType.BLOB:
					convertedValue = applyBlobAffinity(rawValue);
					break;
				default:
					convertedValue = rawValue; // Fallback to no conversion
			}

			valuesForXUpdate[tableColIdx + 1] = convertedValue;
		});

		// Set conflict resolution strategy
		(valuesForXUpdate as any)._onConflict = plan.onConflict || 'abort';

		await vtab.xUpdate!('insert', valuesForXUpdate.slice(1), null);

		// Yield the flat row for RETURNING to access OLD/NEW values
		yield flatRow;
	}

	async function* run(ctx: RuntimeContext, sourceValue: AsyncIterable<Row>): AsyncIterable<Row> {
		// Create a VirtualTable instance for the actual operations
		const vtab = await getVTable(ctx, tableSchema);

		try {
			for await (const flatRow of sourceValue) {
				for await (const insertedRow of processAndYieldRow(vtab, flatRow)) {
					yield insertedRow;
				}
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `insert(${tableSchema.name}, all columns)`
	};
}
