import { PlanNodeType } from "../planner/nodes/plan-node-type.js";
import { registerEmitter, type EmitterFunc } from "./emitters.js";
import { emitBinaryOp } from "./emit/binary.js";
import { emitUnaryOp } from "./emit/unary.js";
import { emitLiteral } from "./emit/literal.js";
import { emitTableScan } from "./emit/scan.js";
import { emitIn } from "./emit/subquery.js";
import { emitBlock } from "./emit/block.js";
import { emitParameterReference } from './emit/parameter.js';
import { emitCreateTable } from './emit/create-table.js';
import { emitDropTable } from './emit/drop-table.js';
import { emitInsert } from './emit/insert.js';
import { emitUpdate } from './emit/update.js';
import { emitDelete } from './emit/delete.js';
import { emitProject } from './emit/project.js';
import { emitColumnReference } from './emit/column-reference.js';
import { emitValues, emitSingleRow } from './emit/values.js';
import { emitFilter } from './emit/filter.js';
import { emitScalarFunctionCall } from './emit/scalar-function.js';

let registered = false;

export function registerEmitters() {
	if (registered) {
		return;
	}
	registered = true;
	registerEmitter(PlanNodeType.BinaryOp, emitBinaryOp as EmitterFunc);
	registerEmitter(PlanNodeType.UnaryOp, emitUnaryOp as EmitterFunc);
	registerEmitter(PlanNodeType.Literal, emitLiteral as EmitterFunc);
	registerEmitter(PlanNodeType.TableScan, emitTableScan as EmitterFunc);
	registerEmitter(PlanNodeType.In, emitIn as EmitterFunc);
	registerEmitter(PlanNodeType.Block, emitBlock as EmitterFunc);
	registerEmitter(PlanNodeType.ParameterReference, emitParameterReference as EmitterFunc);
	registerEmitter(PlanNodeType.CreateTable, emitCreateTable as EmitterFunc);
	registerEmitter(PlanNodeType.DropTable, emitDropTable as EmitterFunc);
	registerEmitter(PlanNodeType.Insert, emitInsert as EmitterFunc);
	registerEmitter(PlanNodeType.Update, emitUpdate as EmitterFunc);
	registerEmitter(PlanNodeType.Delete, emitDelete as EmitterFunc);
	registerEmitter(PlanNodeType.Project, emitProject as EmitterFunc);
	registerEmitter(PlanNodeType.ColumnReference, emitColumnReference as EmitterFunc);
	registerEmitter(PlanNodeType.Values, emitValues as EmitterFunc);
	registerEmitter(PlanNodeType.SingleRow, emitSingleRow as EmitterFunc);
	registerEmitter(PlanNodeType.Filter, emitFilter as EmitterFunc);
	registerEmitter(PlanNodeType.ScalarFunctionCall, emitScalarFunctionCall as EmitterFunc);
}
