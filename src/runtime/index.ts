import { PlanNodeType } from "../planner/nodes/plan-node-type.js";
import { registerEmitter, type EmitterFunc } from "./emitters.js";
import { emitBinaryOp } from "./emit/binary.js";
import { emitLiteral } from "./emit/literal.js";
import { emitTableScan } from "./emit/scan.js";
import { emitIn } from "./emit/subquery.js";
import { emitBatch } from "./emit/batch.js";
import { emitParameterReference } from './emit/parameter.js';

registerEmitter(PlanNodeType.BinaryOp, emitBinaryOp as EmitterFunc);
registerEmitter(PlanNodeType.Literal, emitLiteral as EmitterFunc);
registerEmitter(PlanNodeType.TableScan, emitTableScan as EmitterFunc);
registerEmitter(PlanNodeType.In, emitIn as EmitterFunc);
registerEmitter(PlanNodeType.Batch, emitBatch as EmitterFunc);
registerEmitter(PlanNodeType.ParameterReference, emitParameterReference as EmitterFunc);
