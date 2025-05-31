import type { Scope } from '../scopes/scope.js';
import { VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type * as AST from '../../parser/ast.js';
import { expressionToString } from '../../util/ast-stringify.js';

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
    return `DROP TABLE ${this.statementAst.name.name}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    return {
      table: this.statementAst.name.name,
      schema: this.statementAst.name.schema,
      statement: expressionToString(this.statementAst as any)
    };
  }
}
