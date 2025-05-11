import type { EmissionContext } from './emission-context.js';
import type { PlanNodeEmitter, ProcessRowCallback, VdbeEmitter, VisitOptions } from './vdbe-emitter.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import { ResultNode } from '../planner/nodes/result-node.js';
import { ProjectNode } from '../planner/nodes/project-node.js';
import { TableScanNode } from '../planner/nodes/table-scan-node.js';
import { TableReferenceNode } from '../planner/nodes/reference-nodes.js';
import { ColumnReferenceNode } from '../planner/nodes/reference-nodes.js';
import { createLogger } from '../common/logger.js';
import { Opcode } from '../vdbe/opcodes.js';
import { SqliterError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { P4Vtab } from '../vdbe/instruction.js';

const log = createLogger('emitter:node-emitters');
const warnLog = log.extend('warn');

export const emitResultNode: PlanNodeEmitter = (
  node: PlanNode,
  context: EmissionContext,
  emitter: VdbeEmitter,
  options?: VisitOptions
): void => {
  const resultNode = node as ResultNode;
  log(`Emitting ResultNode: ${resultNode.id}, Input: ${resultNode.input.id}`);
  // ResultNode will define how to process a fully projected row (e.g., emit ResultRow)
  // It passes this logic as a callback to ProjectNode.
  // It also tells ProjectNode where to build the final row.

  // TODO: Allocate or determine targetRegister for the final output row
  const finalOutputBaseReg = options?.targetRegister ?? context.allocateMemoryCells(resultNode.input.getType().columns.length || 1);
  log(`  ResultNode ${resultNode.id} designated R[${finalOutputBaseReg}] for output row.`);

  const processProjectedRowCb: ProcessRowCallback = (cbContext, cbEmitter, cbOptions) => {
    // This callback is executed by ProjectNode *after* it has prepared a full row
    // in the registers starting at finalOutputBaseReg.
    const numResultCols = resultNode.input.getType().columns.length;
    log(`  ResultNode's processProjectedRowCb: Emitting ResultRow from R[${finalOutputBaseReg}] for ${numResultCols} cols`);
    cbContext.emit(Opcode.ResultRow, finalOutputBaseReg, numResultCols);
  };

  emitter.emitChild(resultNode.input, { targetRegister: finalOutputBaseReg, processRowCb: processProjectedRowCb });

  // After the input (ProjectNode->TableScanNode loop) is done, ResultNode might emit Halt, etc.
  // but that's usually handled by the top-level compiler.
};

export const emitProjectNode: PlanNodeEmitter = (
  node: PlanNode,
  context: EmissionContext,
  emitter: VdbeEmitter,
  options?: VisitOptions // Expects targetRegister (where to build projected row) & processRowCb (what to do after row is built)
): void => {
  const projectNode = node as ProjectNode;
  log(`Emitting ProjectNode: ${projectNode.id}, Input: ${projectNode.input.id}, Projections: ${projectNode.projections.length}`);

  if (options?.targetRegister === undefined) {
    warnLog(`ProjectNode ${projectNode.id} was called without a targetRegister. Projection results will not be stored correctly.`);
    // Potentially allocate a temporary buffer here if ProjectNode is meant to be self-contained in some contexts,
    // but for now, assume it's provided by the parent (ResultNode).
    // If we proceed, ColumnReference children will also warn/fail.
  }
  if (!options?.processRowCb) {
    warnLog(`ProjectNode ${projectNode.id} was called without a processRowCb. Projected rows will not be yielded.`);
    // This means there's no mechanism to consume the rows this ProjectNode produces.
  }

  // This is the callback that ProjectNode will give to its input (e.g., TableScanNode).
  // When TableScanNode calls this, it means one raw row is ready from the input.
  const processInputRowAndProjectCb: ProcessRowCallback = (cbContext, cbEmitter, cbLoopOptions) => {
    log(`  ProjectNode ${projectNode.id}: processInputRowAndProjectCb invoked.`);
    // For each projection, emit code to compute it and store it in the correct slot
    // of the targetRegister buffer provided by ProjectNode's parent (ResultNode).
    projectNode.projections.forEach((projection, index) => {
      const projectionTargetRegister = options?.targetRegister !== undefined ? options.targetRegister + index : undefined;
      if (projectionTargetRegister === undefined && projectNode.projections.length > 0) {
        warnLog(`    ProjectNode ${projectNode.id}: Projection ${index} for ${projection.node.toString()} has no target register.`)
      }
      log(`    ProjectNode ${projectNode.id}: Emitting child projection ${index} (${projection.node.toString()}) into R[${projectionTargetRegister}]`);
      cbEmitter.emitChild(projection.node, { targetRegister: projectionTargetRegister });
    });

    // After all columns for the current input row have been projected into the target registers,
    // call the callback provided by ProjectNode's parent (e.g., ResultNode) to yield this complete projected row.
    if (options?.processRowCb) {
      log(`  ProjectNode ${projectNode.id}: Invoking parent's processRowCb to yield the projected row.`);
      options.processRowCb(cbContext, cbEmitter, cbLoopOptions); // cbLoopOptions might be original options from ResultNode
    }
  };

  // Now, instruct our input (e.g., TableScanNode) to execute its loop,
  // using our processInputRowAndProjectCb to handle each row it produces.
  // We don't pass down targetRegister or processRowCb from *our* options directly to TableScanNode,
  // as TableScanNode doesn't use them in that way. It uses the cb we provide now.
  emitter.emitChild(projectNode.input, { processRowCb: processInputRowAndProjectCb });
};

export const emitTableScanNode: PlanNodeEmitter = (
  node: PlanNode,
  context: EmissionContext,
  emitter: VdbeEmitter,
  options?: VisitOptions
): void => {
  const tableScanNode = node as TableScanNode;
  log(`Emitting TableScanNode: ${tableScanNode.id}, Table: ${tableScanNode.input.tableSchema.name}`);

  // 1. Visit TableReference child (mostly for semantic consistency, no VDBE expected)
  emitter.emitChild(tableScanNode.input);

  // 2. Allocate VDBE cursor and map it to this PlanNode
  const vdbeCursorIndex = context.allocateCursor();
  emitter.planNodeToCursorIndex.set(tableScanNode, vdbeCursorIndex);
  log(`  TableScanNode ${tableScanNode.id} (${tableScanNode.input.tableSchema.name}) mapped to VDBE cursor ${vdbeCursorIndex}`);

  // 3. Emit OpenRead for the VTable
  const p4Vtab: P4Vtab = { type: 'vtab', tableSchema: tableScanNode.input.tableSchema };
  context.emit(
    Opcode.OpenRead,
    vdbeCursorIndex,
    0, // p2 (root page) - typically 0 for VTabs or ignored
    0, // p3 (num cols) - typically 0 for VTabs, schema is known
    p4Vtab,
    undefined,
    `OpenRead VTab ${tableScanNode.input.tableSchema.name} on cursor ${vdbeCursorIndex}`
  );

  // 4. Set up the scan loop
  const loopStartAddr = context.allocateAddress(`scan_loop_start_${tableScanNode.id}`);
  const loopEndAddr = context.allocateAddress(`scan_loop_end_${tableScanNode.id}`);

  // Rewind the cursor. If table is empty, jump to loopEndAddr.
  context.emit(Opcode.Rewind, vdbeCursorIndex, loopEndAddr, 0, undefined, undefined, `Rewind cursor ${vdbeCursorIndex}`);

  // Mark the start of the loop body
  context.resolveAddress(loopStartAddr);
  log(`  Loop start for ${tableScanNode.id} at address (placeholder) ${loopStartAddr}`);

  // 5. Execute the row processing callback, if provided
  // This callback is responsible for emitting code to handle the current row (e.g., projections, result row)
  if (options?.processRowCb) {
    log(`  Calling processRowCb for TableScanNode ${tableScanNode.id}`);
    // Pass relevant options down to the callback, e.g., target registers for projections
    options.processRowCb(context, emitter, options);
  } else {
    warnLog(`TableScanNode ${tableScanNode.id} executed without a processRowCb. Loop body will be empty.`);
  }

  // 6. Emit Next to advance the cursor and jump back to loopStartAddr
  context.emit(Opcode.Next, vdbeCursorIndex, loopStartAddr, 0, undefined, undefined, `Next cursor ${vdbeCursorIndex}`);

  // 7. Mark the end of the loop (where Rewind jumps if empty, and where Next falls through when done)
  context.resolveAddress(loopEndAddr);
  log(`  Loop end for ${tableScanNode.id} at address (placeholder) ${loopEndAddr}`);

  // 8. Emit Close to release the cursor
  // TODO: Cursor closing strategy - when is it safe to close? Typically at the end of the whole query
  // or when the cursor is no longer needed. For now, let's assume it's closed here for simplicity,
  // but this might need to be managed more globally (e.g., by the main compiler routine).
  // context.emit(Opcode.Close, vdbeCursorIndex, 0, 0, undefined, undefined, `Close cursor ${vdbeCursorIndex}`);
  log(`  Skipping Opcode.Close for cursor ${vdbeCursorIndex} in TableScanNode emitter (to be handled globally).`);
};

export const emitTableReferenceNode: PlanNodeEmitter = (
  node: PlanNode,
  context: EmissionContext,
  emitter: VdbeEmitter,
  options?: VisitOptions
): void => {
  const tableRefNode = node as TableReferenceNode;
  log(`Emitting TableReferenceNode: ${tableRefNode.id}, Table: ${tableRefNode.tableSchema.name}`);
  // This node generally does not emit VDBE instructions directly.
  // It serves as a structural element and provider of schema information.
  // Cursor allocation and opening are typically handled by consumers like TableScanNode.
};

export const emitColumnReferenceNode: PlanNodeEmitter = (
  node: PlanNode,
  context: EmissionContext,
  emitter: VdbeEmitter,
  options?: VisitOptions
): void => {
  const colRefNode = node as ColumnReferenceNode;
  log(`Emitting ColumnReferenceNode: ${colRefNode.id}, Column: ${colRefNode.expression.name}, Index: ${colRefNode.columnIndex}, TargetReg: ${options?.targetRegister}`);

  if (options?.targetRegister === undefined) {
    warnLog(`ColumnReferenceNode ${colRefNode.id} (${colRefNode.expression.name}) called without a targetRegister. Opcode.Column will not be emitted.`);
    return; // Cannot proceed without a target register
  }

  const vdbeCursorIndex = emitter.planNodeToCursorIndex.get(colRefNode.relationalNode);

  if (vdbeCursorIndex === undefined) {
    // This indicates an internal error: the TableScanNode (or other relational node)
    // that this column refers to should have been processed and its VDBE cursor registered.
    throw new SqliterError(
      `Internal Error: VDBE cursor index not found for relational node ${colRefNode.relationalNode.id} when emitting column ${colRefNode.expression.name}.`,
      StatusCode.INTERNAL
    );
  }

  context.emit(
    Opcode.VColumn,
    vdbeCursorIndex,
    colRefNode.columnIndex,
    options.targetRegister,
    undefined, // P4 usually not used for Column
    undefined, // P5 usually not used for Column
    `${colRefNode.relationalNode.toString()}.${colRefNode.expression.name} -> R[${options.targetRegister}]`
  );
};
