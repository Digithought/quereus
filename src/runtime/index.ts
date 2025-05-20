import { PlanNodeType } from "../planner/nodes/plan-node-type.js";
import { registerEmitter, type EmitterFunc } from "./emitters.js";
import { emitBinaryOp } from "./emit/binary.js";
import { emitLiteral } from "./emit/literal.js";
import { emitTableScan } from "./emit/scan.js";
import { emitIn } from "./emit/subquery.js";
import { emitBlock } from "./emit/block.js";
import { emitParameterReference } from './emit/parameter.js';
import { emitCreateTable } from './emit/create-table.js';
import { emitDropTable } from './emit/drop-table.js';

registerEmitter(PlanNodeType.BinaryOp, emitBinaryOp as EmitterFunc);
registerEmitter(PlanNodeType.Literal, emitLiteral as EmitterFunc);
registerEmitter(PlanNodeType.TableScan, emitTableScan as EmitterFunc);
registerEmitter(PlanNodeType.In, emitIn as EmitterFunc);
registerEmitter(PlanNodeType.Batch, emitBlock as EmitterFunc);
registerEmitter(PlanNodeType.ParameterReference, emitParameterReference as EmitterFunc);
registerEmitter(PlanNodeType.CreateTable, emitCreateTable as EmitterFunc);
registerEmitter(PlanNodeType.DropTable, emitDropTable as EmitterFunc);
