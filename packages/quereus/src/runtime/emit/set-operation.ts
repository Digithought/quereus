import type { SetOperationNode } from '../../planner/nodes/set-operation-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';

export function emitSetOperation(plan: SetOperationNode, ctx: EmissionContext): Instruction {
  const leftInst = emitPlanNode(plan.left, ctx);
  const rightInst = emitPlanNode(plan.right, ctx);

  // Helper function to create a properly structured output row
  function createOutputRow(inputRow: Row): Row {
    const outputRow: Row = [];
    plan.getAttributes().forEach((attr, idx) => {
      outputRow[idx] = inputRow[idx]; // Map by position since columns should align
    });
    return outputRow;
  }

  async function* runUnionAll(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Process left rows - let SortNode handle row context
    for await (const row of leftRows) {
      yield createOutputRow(row);
    }

    // Process right rows - let SortNode handle row context
    for await (const row of rightRows) {
      yield createOutputRow(row);
    }
  }

  async function* runUnionDistinct(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    const seen = new Set<string>();
    const hash = (row: Row) => JSON.stringify(row);
    for await (const row of leftRows) {
      const outputRow = createOutputRow(row);
      const h = hash(outputRow);
      if (!seen.has(h)) {
        seen.add(h);
        yield outputRow; // Let SortNode handle row context
      }
    }
    for await (const row of rightRows) {
      const outputRow = createOutputRow(row);
      const h = hash(outputRow);
      if (!seen.has(h)) {
        seen.add(h);
        yield outputRow; // Let SortNode handle row context
      }
    }
  }

  async function* runIntersect(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    const leftSet = new Set<string>();
    const hash = (row: Row) => JSON.stringify(row);
    const leftRowsArray: Row[] = [];
    for await (const row of leftRows) {
      const outputRow = createOutputRow(row);
      leftSet.add(hash(outputRow));
      leftRowsArray.push(outputRow);
    }
    for await (const row of rightRows) {
      const outputRow = createOutputRow(row);
      const h = hash(outputRow);
      if (leftSet.has(h)) {
        yield outputRow; // Let SortNode handle row context
        leftSet.delete(h);
      }
    }
  }

  async function* runExcept(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    const rightSet = new Set<string>();
    const hash = (row: Row) => JSON.stringify(row);
    const leftRowsArray: Row[] = [];
    for await (const row of leftRows) {
      leftRowsArray.push(createOutputRow(row));
    }
    for await (const row of rightRows) {
      rightSet.add(hash(createOutputRow(row)));
    }
    for (const outputRow of leftRowsArray) {
      const h = hash(outputRow);
      if (!rightSet.has(h)) {
        yield outputRow; // Let SortNode handle row context
      }
    }
  }

  let run: InstructionRun;
  switch (plan.op) {
    case 'unionAll':
      run = runUnionAll as InstructionRun;
      break;
    case 'union':
      run = runUnionDistinct as InstructionRun;
      break;
    case 'intersect':
      run = runIntersect as InstructionRun;
      break;
    case 'except':
      run = runExcept as InstructionRun;
      break;
  }

  return {
    params: [leftInst, rightInst],
    run,
    note: plan.op
  };
}
