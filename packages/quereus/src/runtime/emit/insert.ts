import type { InsertNode } from '../../planner/nodes/insert-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row, SqlDataType } from '../../common/types.js';
import { getVTableConnection, getVTable, disconnectVTable } from '../utils.js';
import type { EmissionContext } from '../emission-context.js';
import { applyIntegerAffinity, applyRealAffinity, applyNumericAffinity, applyTextAffinity, applyBlobAffinity } from '../../util/affinity.js';

export function emitInsert(plan: InsertNode, ctx: EmissionContext): Instruction {
  const tableSchema = plan.table.tableSchema;

  // Create row descriptor for the output attributes (for RETURNING support)
  const outputRowDescriptor: RowDescriptor = [];
  const outputAttributes = plan.getAttributes();
  outputAttributes.forEach((attr, index) => {
    outputRowDescriptor[attr.id] = index;
  });

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

  // This function processes a single row and conditionally yields it for RETURNING
  async function* processAndYieldRow(vtab: any, rowToInsert: Row): AsyncIterable<Row> {
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

    // Fill in default values for omitted columns
    tableSchema.columns.forEach((col, idx) => {
      if (valuesForXUpdate[idx + 1] === null && !targetColumnIndices.includes(idx)) {
        if (col.defaultValue !== undefined) {
          if (typeof col.defaultValue === 'object' && col.defaultValue !== null && 'type' in col.defaultValue) {
            throw new QuereusError(`Default value expressions not yet supported for column '${col.name}'`, StatusCode.UNSUPPORTED);
          }
          valuesForXUpdate[idx + 1] = col.defaultValue as SqlValue;
        } else {
          // Explicitly set NULL for omitted columns without defaults
          valuesForXUpdate[idx + 1] = null;
        }
      }
    });

        // Set conflict resolution strategy
    (valuesForXUpdate as any)._onConflict = plan.onConflict || 'abort';

    await vtab.xUpdate!('insert', valuesForXUpdate.slice(1), null);

    // Always yield the inserted row (even for non-RETURNING cases, as optimizer will filter)
    yield valuesForXUpdate.slice(1) as Row;
  }

  async function* run(ctx: RuntimeContext, sourceValue: AsyncIterable<Row>): AsyncIterable<Row> {
    // Get or create a connection for this table to ensure transaction consistency
    const connection = await getVTableConnection(ctx, tableSchema);

    // Create a VirtualTable instance for the actual operations
    const vtab = await getVTable(ctx, tableSchema);

    try {
      for await (const row of sourceValue) {
        for await (const insertedRow of processAndYieldRow(vtab, row)) {
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
    note: `insert(${plan.table.tableSchema.name}, ${plan.targetColumns.length || tableSchema.columns.length} cols)`
  };
}
