import type { RuntimeValue, SqlParameters, OutputValue, Row, SqlValue } from "../common/types.js";
import type { Database } from "../core/database.js";
import type { Statement } from "../core/statement.js";
import type { PlanNode } from "../planner/nodes/plan-node.js";

export type RuntimeContext = {
	db: Database;
	stmt: Statement | null; // Can be null for transient exec statements
	params: SqlParameters; // User-provided values for the current execution
	context: Map<PlanNode, () => SqlValue | Row>;
};

export type InstructionRun = (ctx: RuntimeContext, ...args: RuntimeValue[]) => OutputValue;

export type Instruction = {
	params: Instruction[];
	run: InstructionRun;
};
