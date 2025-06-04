import type { CreateIndexNode } from '../../planner/nodes/create-index-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitCreateIndex(plan: CreateIndexNode, ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue | undefined> {
		await rctx.db.schemaManager.createIndex(plan.statementAst);
		// The specific error handling for IF NOT EXISTS is within SchemaManager.createIndex.

		return null; // Explicitly return null for successful void operations
	}

	return { params: [], run: run as InstructionRun };
}
