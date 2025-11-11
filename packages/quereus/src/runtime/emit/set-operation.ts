import type { SetOperationNode } from '../../planner/nodes/set-operation-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import { BTree } from 'inheritree';
import { compareRows } from '../../util/comparison.js';

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
    // Use BTree for proper SQL value comparison instead of JSON.stringify
    const distinctTree = new BTree<Row, Row>(
      (row: Row) => row,
      compareRows
    );

    for await (const row of leftRows) {
      const outputRow = createOutputRow(row);
      const newPath = distinctTree.insert(outputRow);
      if (newPath.on) {
        // This is a new distinct row
        yield outputRow; // Let SortNode handle row context
      }
    }
    for await (const row of rightRows) {
      const outputRow = createOutputRow(row);
      const newPath = distinctTree.insert(outputRow);
      if (newPath.on) {
        // This is a new distinct row
        yield outputRow; // Let SortNode handle row context
      }
    }
  }

  async function* runIntersect(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Use BTree for proper SQL value comparison
    const leftTree = new BTree<Row, Row>(
      (row: Row) => row,
      compareRows
    );

    // Build left set
    for await (const row of leftRows) {
      const outputRow = createOutputRow(row);
      leftTree.insert(outputRow);
    }

    // Check right rows against left set
    const yielded = new BTree<Row, Row>(
      (row: Row) => row,
      compareRows
    );

    for await (const row of rightRows) {
      const outputRow = createOutputRow(row);
      const leftPath = leftTree.find(outputRow);
      if (leftPath.on) {
        // This row exists in left set
        const yieldedPath = yielded.insert(outputRow);
        if (yieldedPath.on) {
          // Haven't yielded this row yet (handles duplicates in right)
          yield outputRow; // Let SortNode handle row context
        }
      }
    }
  }

  async function* runExcept(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Use BTree for proper SQL value comparison
    const rightTree = new BTree<Row, Row>(
      (row: Row) => row,
      compareRows
    );
    const leftRowsArray: Row[] = [];

    // Collect left rows
    for await (const row of leftRows) {
      leftRowsArray.push(createOutputRow(row));
    }

    // Build right set
    for await (const row of rightRows) {
      rightTree.insert(createOutputRow(row));
    }

    // Yield left rows that are not in right set
    for (const outputRow of leftRowsArray) {
      const rightPath = rightTree.find(outputRow);
      if (!rightPath.on) {
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
