import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { LiteralNode, BinaryOpNode } from '../nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode, FunctionReferenceNode } from '../nodes/reference.js';
import { ScalarFunctionCallNode } from '../nodes/function.js';
import type { PlanNode, ScalarPlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, SqlDataType } from '../../common/types.js';
import type { ScalarType } from '../../common/datatype.js';
import { resolveColumn, resolveParameter, resolveFunction } from '../resolve.js';
import { Ambiguous } from '../scopes/scope.js';
import { buildSelectStmt } from './select.js';
import { getLiteralSqlType } from '../../common/type-inference.js';

function inferExpressionType(expr: AST.Expression, ctx: PlanningContext): ScalarType {
  switch (expr.type) {
    case 'literal':
      const literalType = getLiteralSqlType(expr.value);
      return { typeClass: 'scalar', affinity: literalType === SqlDataType.NULL ? SqlDataType.TEXT : literalType, nullable: expr.value === null, isReadOnly: true, datatype: literalType };
    case 'column':
      const colRef = resolveColumn(ctx.scope, expr, 'main');
      if (!colRef || colRef === Ambiguous) throw new QuereusError(`Column not found or ambiguous: ${expr.name}`, StatusCode.ERROR);
      return colRef.getType();
    case 'parameter':
      const paramRef = resolveParameter(ctx.scope, expr);
      if (!paramRef || paramRef === Ambiguous) throw new QuereusError(`Param not found: ${expr.name ?? expr.index}`, StatusCode.ERROR);
      return paramRef.getType();
    case 'binary':
      if (['=', '!=', '<', '<=', '>', '>=', 'AND', 'OR', 'IS', 'IS NOT', 'IN', 'LIKE', 'GLOB'].includes(expr.operator)) {
        return { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true, datatype: SqlDataType.INTEGER };
      }
      return { typeClass: 'scalar', affinity: SqlDataType.NUMERIC, nullable: true, isReadOnly: true };
    case 'unary':
        if (expr.operator === 'NOT') return { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true, datatype: SqlDataType.INTEGER };
        return inferExpressionType(expr.expr, ctx);
    case 'function':
        // TODO: Fix function resolution - temporarily return a basic type
        return { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true };
    case 'cast':
        // TODO: Fix getAffinity - temporarily return TEXT
        return { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true, datatype: SqlDataType.TEXT };
    case 'case':
        if(expr.whenThenClauses.length > 0) return inferExpressionType(expr.whenThenClauses[0].then, ctx);
        if(expr.elseExpr) return inferExpressionType(expr.elseExpr, ctx);
        return { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true };
    default:
      throw new QuereusError(`Type inference not implemented for expression type: ${(expr as any).type}`, StatusCode.UNSUPPORTED);
  }
}

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
      if (!funcResolution || funcResolution === Ambiguous || funcResolution.nodeType !== PlanNodeType.TableFunctionReference) {
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
