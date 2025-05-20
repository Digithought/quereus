import type { BaseType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type * as AST from '../../parser/ast.js';
/**
 * Represents a DROP TABLE statement in the logical query plan.
 */
export class DropTableNode extends VoidNode {
  override readonly nodeType = PlanNodeType.DropTable;

  constructor(
    scope: Scope,
    public readonly statementAst: AST.DropStmt,
  ) {
    super(scope);
  }

  override toString(): string {
    return `${this.nodeType} (${this.statementAst.name.name})`;
  }
}
