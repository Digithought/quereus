import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateTableNode } from '../nodes/create-table-node.js';
import { CreateIndexNode } from '../nodes/create-index-node.js';

export function buildCreateTableStmt(
  context: PlanningContext,
  stmt: AST.CreateTableStmt,
): CreateTableNode {
  return new CreateTableNode(
    context.scope,
    stmt,
  );
}

export function buildCreateIndexStmt(
	context: PlanningContext,
	stmt: AST.CreateIndexStmt
): CreateIndexNode {
	return new CreateIndexNode(
		context.scope,
		stmt
	);
}
