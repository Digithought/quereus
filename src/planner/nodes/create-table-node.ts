import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';

/**
 * Represents a CREATE TABLE statement in the logical query plan.
 */
export class CreateTableNode extends VoidNode {
  override readonly nodeType = PlanNodeType.CreateTable;

  constructor(
    scope: Scope,
		public readonly statementAst: AST.CreateTableStmt,
  ) {
    super(scope);
  }

  override toString(): string {
    return `${this.nodeType} (${this.statementAst.table.name})`;
  }
}
