import type { PlanningContext } from '../planning-context.js';
import type * as AST from '../../parser/ast.js';
import { DropAssertionNode } from '../nodes/drop-assertion-node.js';

export function buildDropAssertionStmt(ctx: PlanningContext, stmt: AST.DropStmt): DropAssertionNode {
	if (stmt.objectType !== 'assertion') {
		throw new Error('Expected DROP ASSERTION statement');
	}

	return new DropAssertionNode(ctx.scope, stmt.name.name, stmt.ifExists);
}
