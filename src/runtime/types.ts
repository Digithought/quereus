import type { RuntimeValue, SqlParameters } from "../common/types.js";
import type { Database } from "../core/database.js";
import type { Statement } from "../core/statement.js";

export type RuntimeContext = {
	db: Database;
	stmt: Statement;
	params: SqlParameters;
};

export type Instruction = {
	params: Instruction[];
	run: (ctx: RuntimeContext, ...args: RuntimeValue[]) => RuntimeValue;
};

