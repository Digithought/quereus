import type { CreateTableNode } from '../../planner/nodes/create-table-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { type SqlValue } from '../../common/types.js';

export function emitCreateTable(plan: CreateTableNode): Instruction {
	async function run(ctx: RuntimeContext): Promise<SqlValue | undefined> {
		await ctx.db.schemaManager.createTable(plan.statementAst);
		// The specific error handling for IF NOT EXISTS is within SchemaManager.defineTable.

		return null; // Explicitly return null for successful void operations
	}

	return { params: [], run: run as InstructionRun };
}
