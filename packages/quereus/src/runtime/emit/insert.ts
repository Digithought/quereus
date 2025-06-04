import type { InsertNode } from '../../planner/nodes/insert-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row, SqlDataType } from '../../common/types.js';
import { getVTableConnection, getVTable, disconnectVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { applyIntegerAffinity, applyRealAffinity, applyNumericAffinity, applyTextAffinity, applyBlobAffinity } from '../../util/affinity.js';

export function emitInsert(plan: InsertNode, ctx: EmissionContext): Instruction {
  const tableSchema = plan.table.tableSchema;
	// InsertNode is now a VoidNode by default; only RETURNING wraps it in ProjectNode
	const isReturning = false;

  // Compute targetColumnIndices at emit time
  const targetColumnIndices: number[] = [];
  if (plan.targetColumns.length > 0) {
    plan.targetColumns.forEach(tc => {
      const idx = tableSchema.columnIndexMap.get(tc.name.toLowerCase());
      if (idx === undefined) {
        throw new QuereusError(`Column '${tc.name}' not found in table '${tableSchema.name}' during emitInsert.`, StatusCode.INTERNAL);
      }
      targetColumnIndices.push(idx);
    });
  } else {
    tableSchema.columns.forEach((col, idx) => {
      targetColumnIndices.push(idx);
    });
  }

  // This function processes a single row and conditionally yields it if RETURNING
  async function* processAndYieldIfNeeded(vtab: any, rowToInsert: Row): AsyncIterable<Row> {
    const valuesForXUpdate: SqlValue[] = new Array(tableSchema.columns.length + 1).fill(null);
    valuesForXUpdate[0] = null; // Placeholder for key, null for INSERT with xUpdate

    if (rowToInsert.length !== targetColumnIndices.length) {
      throw new QuereusError(`Column count mismatch for INSERT into '${tableSchema.name}'. Expected ${targetColumnIndices.length}, got ${rowToInsert.length}.`, StatusCode.ERROR);
    }

    targetColumnIndices.forEach((tableColIdx, i) => {
      const rawValue = rowToInsert[i];
      const columnSchema = tableSchema.columns[tableColIdx];

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

    tableSchema.columns.forEach((col, idx) => {
      if (valuesForXUpdate[idx + 1] === null && !targetColumnIndices.includes(idx)) {
        if (col.defaultValue !== undefined) {
          if (typeof col.defaultValue === 'object' && col.defaultValue !== null && 'type' in col.defaultValue) {
            throw new QuereusError(`Default value expressions not yet supported for column '${col.name}'`, StatusCode.UNSUPPORTED);
          }
          valuesForXUpdate[idx + 1] = col.defaultValue as SqlValue;
        }
      }
    });

    (valuesForXUpdate as any)._onConflict = plan.onConflict || 'abort';
    await vtab.xUpdate!('insert', valuesForXUpdate.slice(1), null);

    if (isReturning) {
      yield valuesForXUpdate.slice(1); // Yield the data part of the inserted row
    }
  }

  async function* runLogic(ctx: RuntimeContext, sourceValue: AsyncIterable<Row>): AsyncIterable<Row> {
    // Get or create a connection for this table to ensure transaction consistency
    const connection = await getVTableConnection(ctx, tableSchema);

    // Create a VirtualTable instance for the actual operations
    const vtab = await getVTable(ctx, tableSchema);

    try {
			for await (const row of sourceValue) {
				for await (const returningRow of processAndYieldIfNeeded(vtab, row)) {
					yield returningRow; // Only yields if RETURNING is active
				}
			}
    } finally {
      await disconnectVTable(ctx, vtab);
    }
  }

  async function run(ctx: RuntimeContext, sourceValue: AsyncIterable<Row>): Promise<AsyncIterable<Row> | SqlValue | undefined> {
    const resultsIterable = runLogic(ctx, sourceValue);
    if (isReturning) {
        return resultsIterable; // Return the async generator directly
    } else {
        // If not returning, consume the generator to execute inserts, then return undefined
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of resultsIterable) { /* Consume to execute */ }
        return undefined;
    }
  }

  const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
    params: [sourceInstruction],
    run: run as InstructionRun,
    note: `insert(${plan.table.tableSchema.name}, ${plan.targetColumns.length || tableSchema.columns.length} cols)`
  };
}
