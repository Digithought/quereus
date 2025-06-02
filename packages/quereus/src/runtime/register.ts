import { PlanNodeType } from "../planner/nodes/plan-node-type.js";
import { emitPlanNode, registerEmitter, type EmitterFunc } from "./emitters.js";
import { emitBinaryOp } from "./emit/binary.js";
import { emitUnaryOp } from "./emit/unary.js";
import { emitLiteral } from "./emit/literal.js";
import { emitSeqScan } from "./emit/scan.js";
import { emitIn } from "./emit/subquery.js";
import { emitBlock } from "./emit/block.js";
import { emitParameterReference } from './emit/parameter.js';
import { emitCreateTable } from './emit/create-table.js';
import { emitDropTable } from './emit/drop-table.js';
import { emitCreateView } from './emit/create-view.js';
import { emitDropView } from './emit/drop-view.js';
import { emitCTE } from './emit/cte.js';
import { emitTableReference } from './emit/table-reference.js';
import { emitInsert } from './emit/insert.js';
import { emitUpdate } from './emit/update.js';
import { emitDelete } from './emit/delete.js';
import { emitProject } from './emit/project.js';
import { emitColumnReference } from './emit/column-reference.js';
import { emitValues, emitSingleRow } from './emit/values.js';
import { emitFilter } from './emit/filter.js';
import { emitDistinct } from './emit/distinct.js';
import { emitScalarFunctionCall } from './emit/scalar-function.js';
import { emitLimitOffset } from './emit/limit-offset.js';
import { emitStreamAggregate } from './emit/aggregate.js';
import { emitCaseExpr } from './emit/case.js';
import { emitCast } from './emit/cast.js';
import { emitCollate } from "./emit/collate.js";
import { emitTableValuedFunctionCall } from './emit/table-valued-function.js';
import { emitTransaction } from './emit/transaction.js';
import { emitPragma } from './emit/pragma.js';
import { emitSort } from './emit/sort.js';
import { emitWindow } from './emit/window.js';
import { emitSequencing } from './emit/sequencing.js';
import { emitRecursiveCTE } from './emit/recursive-cte.js';
import { emitSetOperation } from './emit/set-operation.js';

let registered = false;

export function registerEmitters() {
	if (registered) {
		return;
	}
	registered = true;

	// Scalar expression emitters
	registerEmitter(PlanNodeType.BinaryOp, emitBinaryOp as EmitterFunc);
	registerEmitter(PlanNodeType.UnaryOp, emitUnaryOp as EmitterFunc);
	registerEmitter(PlanNodeType.Literal, emitLiteral as EmitterFunc);
	registerEmitter(PlanNodeType.ColumnReference, emitColumnReference as EmitterFunc);
	registerEmitter(PlanNodeType.ParameterReference, emitParameterReference as EmitterFunc);
	registerEmitter(PlanNodeType.ScalarFunctionCall, emitScalarFunctionCall as EmitterFunc);
	registerEmitter(PlanNodeType.CaseExpr, emitCaseExpr as EmitterFunc);
	registerEmitter(PlanNodeType.Cast, emitCast as EmitterFunc);
	registerEmitter(PlanNodeType.Collate, emitCollate as EmitterFunc);

	// Relational emitters (mix of logical and physical for now)
	registerEmitter(PlanNodeType.Block, emitBlock as EmitterFunc);
	registerEmitter(PlanNodeType.TableReference, emitTableReference as EmitterFunc);
	registerEmitter(PlanNodeType.TableScan, emitSeqScan as EmitterFunc);
	registerEmitter(PlanNodeType.Values, emitValues as EmitterFunc);
	registerEmitter(PlanNodeType.SingleRow, emitSingleRow as EmitterFunc);
	registerEmitter(PlanNodeType.Filter, emitFilter as EmitterFunc);
	registerEmitter(PlanNodeType.Project, emitProject as EmitterFunc);
	registerEmitter(PlanNodeType.Distinct, emitDistinct as EmitterFunc);
	registerEmitter(PlanNodeType.Sort, emitSort as EmitterFunc);
	registerEmitter(PlanNodeType.LimitOffset, emitLimitOffset as EmitterFunc);
	registerEmitter(PlanNodeType.TableFunctionCall, emitTableValuedFunctionCall as EmitterFunc);
	registerEmitter(PlanNodeType.In, emitIn as EmitterFunc);
	registerEmitter(PlanNodeType.Window, emitWindow as EmitterFunc);
	registerEmitter(PlanNodeType.Sequencing, emitSequencing as EmitterFunc);
	registerEmitter(PlanNodeType.CTE, emitCTE as EmitterFunc);
	registerEmitter(PlanNodeType.RecursiveCTE, emitRecursiveCTE as EmitterFunc);

	// Physical aggregate emitters
	registerEmitter(PlanNodeType.StreamAggregate, emitStreamAggregate as EmitterFunc);
	// TODO: registerEmitter(PlanNodeType.HashAggregate, emitHashAggregate as EmitterFunc);

	// DML/DDL emitters
	registerEmitter(PlanNodeType.CreateTable, emitCreateTable as EmitterFunc);
	registerEmitter(PlanNodeType.DropTable, emitDropTable as EmitterFunc);
	registerEmitter(PlanNodeType.CreateView, emitCreateView as EmitterFunc);
	registerEmitter(PlanNodeType.DropView, emitDropView as EmitterFunc);
	registerEmitter(PlanNodeType.Insert, emitInsert as EmitterFunc);
	registerEmitter(PlanNodeType.Update, emitUpdate as EmitterFunc);
	registerEmitter(PlanNodeType.Delete, emitDelete as EmitterFunc);

	// Transaction control emitters
	registerEmitter(PlanNodeType.Transaction, emitTransaction as EmitterFunc);
	registerEmitter(PlanNodeType.Pragma, emitPragma as EmitterFunc);

	// Set operation emitter
	registerEmitter(PlanNodeType.SetOperation, emitSetOperation as EmitterFunc);
}
