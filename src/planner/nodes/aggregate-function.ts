import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type ScalarPlanNode } from './plan-node.js';
import type { ScalarType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { FunctionSchema } from '../../schema/function.js';
import type * as AST from '../../parser/ast.js';

/**
 * Represents an aggregate function call (e.g., COUNT(*), SUM(column), etc.)
 * This is different from ScalarFunctionCallNode as it's used in aggregate contexts.
 */
export class AggregateFunctionCallNode extends PlanNode implements ScalarPlanNode {
  override readonly nodeType = PlanNodeType.ScalarFunctionCall; // Reuse the same type for now

  constructor(
    scope: Scope,
    public readonly expression: AST.FunctionExpr,
    public readonly functionSchema: FunctionSchema,
    public readonly returnType: ScalarType,
    public readonly args: readonly ScalarPlanNode[]
  ) {
    super(scope);
  }

  getType(): ScalarType {
    return this.returnType;
  }

  getChildren(): readonly ScalarPlanNode[] {
    return this.args;
  }

  getRelations(): readonly [] {
    return [];
  }

  get functionName(): string {
    return this.expression.name;
  }

  override toString(): string {
    const argsStr = this.args.length > 0 ? this.args.map(arg => arg.toString()).join(', ') : '*';
    return `${super.toString()} (${this.functionName})`;
  }
}
