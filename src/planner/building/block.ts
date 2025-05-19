import { BlockNode } from '../nodes/block.js';
import * as AST from '../../parser/ast.js';
import type { Database } from '../../core/database.js';
import { GlobalScope } from '../scopes/global.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { buildSelectStmt } from './select.js';
import { ParameterScope } from '../scopes/param.js';
import type { PlanningContext } from '../planning-context.js';

export function buildBlock(ctx: PlanningContext, statements: AST.Statement[]): BlockNode {
	const plannedStatements = statements.map((stmt) => {
		if (stmt.type === 'select') {
            // buildSelectStmt returns a BatchNode, which is a PlanNode.
			return buildSelectStmt(stmt as AST.SelectStmt, ctx);
		} else {
			// Placeholder for other statement types
			return undefined;
		}
	}).filter(p => p !== undefined); // Ensure we only have valid PlanNodes

    // The final BatchNode for the entire batch.
    // Its scope is batchParameterScope, and it contains all successfully planned statements.
	return new BlockNode(ctx.scope, plannedStatements, { ...ctx.parameters });
}


