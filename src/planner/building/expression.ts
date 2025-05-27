import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { LiteralNode, BinaryOpNode, UnaryOpNode } from '../nodes/scalar.js';
import { ScalarFunctionCallNode } from '../nodes/function.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, SqlDataType } from '../../common/types.js';
import type { ScalarType } from '../../common/datatype.js';
import { resolveColumn, resolveParameter, resolveFunction } from '../resolve.js';
import { Ambiguous } from '../scopes/scope.js';
import { buildSelectStmt } from './select.js';

export function buildExpression(ctx: PlanningContext, expr: AST.Expression): ScalarPlanNode {
  switch (expr.type) {
    case 'literal':
      return new LiteralNode(ctx.scope, expr);
    case 'column':
      const colResolution = resolveColumn(ctx.scope, expr, 'main');
      if (!colResolution || colResolution === Ambiguous) {
        throw new QuereusError(`Column not found: ${expr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      return colResolution;
    case 'parameter':
      const paramResolution = resolveParameter(ctx.scope, expr);
      if (!paramResolution || paramResolution === Ambiguous) {
        throw new QuereusError(`Parameter not found: ${expr.name ?? expr.index}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      return paramResolution;
    case 'unary':
      const operand = buildExpression(ctx, expr.expr);
      return new UnaryOpNode(ctx.scope, expr, operand);
    case 'binary':
      const left = buildExpression(ctx, expr.left);
      const right = buildExpression(ctx, expr.right);
      if (expr.operator.toUpperCase() === 'IN' && expr.right.type === 'subquery') {
          const subqueryPlan = buildSelectStmt(ctx, expr.right.query);
          if (subqueryPlan.getType().typeClass !== 'relation') {
              throw new QuereusError('IN subquery must produce a relation', StatusCode.ERROR);
          }
          // TODO: Check column count once type system is fixed
          // if (subqueryPlan.getType().columns.length !== 1) {
          //     throw new QuereusError('IN subquery must select exactly one column', StatusCode.ERROR);
          // }
          throw new QuereusError("IN (SELECT ...) not fully implemented in buildExpression yet", StatusCode.UNSUPPORTED);
      }
      return new BinaryOpNode(ctx.scope, expr, left, right);
    case 'function':
      const funcResolution = resolveFunction(ctx.scope, expr);
      if (!funcResolution || funcResolution === Ambiguous) {
        throw new QuereusError(`Function not found/ambiguous: ${expr.name}/${expr.args.length}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      const args = expr.args.map(arg => buildExpression(ctx, arg));
      // TODO: Fix function return type resolution
      const resolvedReturnType: ScalarType = { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true };
      return new ScalarFunctionCallNode(ctx.scope, expr, resolvedReturnType, args);
    default:
      throw new QuereusError(`Expression type '${(expr as any).type}' not yet supported in buildExpression.`, StatusCode.UNSUPPORTED);
  }
}
