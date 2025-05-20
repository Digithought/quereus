import { BlockNode } from '../nodes/block.js';
import * as AST from '../../parser/ast.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { buildSelectStmt } from './select.js';
import type { PlanningContext } from '../planning-context.js';
import { buildCreateTableStmt } from './create-table.js';
import { buildDropTableStmt } from './drop-table.js';

export function buildBlock(ctx: PlanningContext, statements: AST.Statement[]): BlockNode {
	const plannedStatements = statements.map((stmt) => {
		switch (stmt.type) {
			case 'select':
				// buildSelectStmt returns a BatchNode, which is a PlanNode.
				return buildSelectStmt(stmt as AST.SelectStmt, ctx);
			case 'createTable':
				return buildCreateTableStmt(ctx, stmt as AST.CreateTableStmt);
			case 'drop':
				if (stmt.objectType === 'table') {
					return buildDropTableStmt(ctx, stmt as AST.DropStmt);
				}
				break;
			default:
				// Placeholder for other statement types
				return undefined;
		}
	}).filter(p => p !== undefined) as PlanNode[]; // Ensure we only have valid PlanNodes and cast

    // The final BatchNode for the entire batch.
    // Its scope is batchParameterScope, and it contains all successfully planned statements.
	return new BlockNode(ctx.scope, plannedStatements, { ...ctx.parameters });
}


