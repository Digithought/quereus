import type { CreateTableNode } from '../../planner/nodes/create-table-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitCreateTable(plan: CreateTableNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue | undefined> {
		await rctx.db.schemaManager.createTable(plan.statementAst);
		// The specific error handling for IF NOT EXISTS is within SchemaManager.defineTable.

		return null; // Explicitly return null for successful void operations
	}

	return { params: [], run: run as InstructionRun };
}
