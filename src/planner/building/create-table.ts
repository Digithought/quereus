import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateTableNode } from '../nodes/create-table-node.js';

export function buildCreateTableStmt(
  context: PlanningContext,
  stmt: AST.CreateTableStmt,
): CreateTableNode {
  return new CreateTableNode(
    context.scope,
    stmt,
  );
}
