import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import type { PlanNodeEmitter } from './vdbe-emitter.js';
import { emitResultNode, emitProjectNode, emitTableScanNode, emitTableReferenceNode, emitColumnReferenceNode } from './plan-node-emitters.js';

export const planNodeEmitters: Map<PlanNodeType, PlanNodeEmitter> = new Map([
  [PlanNodeType.Result, emitResultNode],
  [PlanNodeType.Project, emitProjectNode],
  [PlanNodeType.TableScan, emitTableScanNode],
  [PlanNodeType.TableReference, emitTableReferenceNode],
  [PlanNodeType.ColumnReference, emitColumnReferenceNode],
  // TODO: Add other emitters here as they are created
]);

