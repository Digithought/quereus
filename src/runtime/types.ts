import type { RuntimeValue, SqlParameters, OutputValue } from "../common/types.js";
import type { Database } from "../core/database.js";
import type { Statement } from "../core/statement.js";

export type RuntimeContext = {
	db: Database;
	stmt: Statement;
	params: SqlParameters;
};

export type InstructionRun = (ctx: RuntimeContext, ...args: RuntimeValue[]) => OutputValue;

export type Instruction = {
	params: Instruction[];
	run: InstructionRun;
};

