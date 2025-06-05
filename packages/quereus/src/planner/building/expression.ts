import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { LiteralNode, BinaryOpNode, UnaryOpNode, CaseExprNode, CastNode, CollateNode } from '../nodes/scalar.js';
import { ScalarFunctionCallNode } from '../nodes/function.js';
import { AggregateFunctionCallNode } from '../nodes/aggregate-function.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { ScalarSubqueryNode, InNode } from '../nodes/subquery.js';
import type { ScalarPlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, SqlDataType } from '../../common/types.js';
import type { ScalarType } from '../../common/datatype.js';
import { resolveColumn, resolveParameter, resolveFunction } from '../resolve.js';
import { Ambiguous } from '../scopes/scope.js';
import { buildSelectStmt } from './select.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';

export function buildExpression(ctx: PlanningContext, expr: AST.Expression, allowAggregates: boolean = false): ScalarPlanNode {
  switch (expr.type) {
    case 'literal':
      return new LiteralNode(ctx.scope, expr);
    case 'column':
      const colResolution = resolveColumn(ctx.scope, expr);
      if (!colResolution || colResolution === Ambiguous) {
        throw new QuereusError(`Column not found: ${expr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      return colResolution as ScalarPlanNode;
    case 'parameter':
      const paramResolution = resolveParameter(ctx.scope, expr);
      if (!paramResolution || paramResolution === Ambiguous) {
        throw new QuereusError(`Parameter not found: ${expr.name ?? expr.index}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      return paramResolution as ScalarPlanNode;
    case 'unary':
      const operand = buildExpression(ctx, expr.expr, allowAggregates);
      return new UnaryOpNode(ctx.scope, expr, operand);
    case 'binary':
      const left = buildExpression(ctx, expr.left, allowAggregates);
      const right = buildExpression(ctx, expr.right, allowAggregates);
      return new BinaryOpNode(ctx.scope, expr, left, right);
    case 'case':
      // Build base expression if present
      const baseExpr = expr.baseExpr ? buildExpression(ctx, expr.baseExpr, allowAggregates) : undefined;

      // Build WHEN/THEN clauses
      const whenThenClauses = expr.whenThenClauses.map(clause => ({
        when: buildExpression(ctx, clause.when, allowAggregates),
        then: buildExpression(ctx, clause.then, allowAggregates)
      }));

      // Build ELSE expression if present
      const elseExpr = expr.elseExpr ? buildExpression(ctx, expr.elseExpr, allowAggregates) : undefined;

      return new CaseExprNode(ctx.scope, expr, baseExpr, whenThenClauses, elseExpr);
    case 'cast':
      const castOperand = buildExpression(ctx, expr.expr, allowAggregates);
      return new CastNode(ctx.scope, expr, castOperand);
    case 'collate':
      const collateOperand = buildExpression(ctx, expr.expr, allowAggregates);
      return new CollateNode(ctx.scope, expr, collateOperand);
    case 'function':
      // In HAVING context, check if this function matches an existing aggregate
      if (ctx.aggregates && ctx.aggregates.length > 0) {
        // Try to find a matching aggregate
        for (const agg of ctx.aggregates) {
          if (agg.expression instanceof AggregateFunctionCallNode) {
            const aggFuncNode = agg.expression as AggregateFunctionCallNode;
            // Check if function name matches and argument count matches
            if (aggFuncNode.functionName.toLowerCase() === expr.name.toLowerCase() &&
                aggFuncNode.args.length === expr.args.length) {
              // Check if arguments match
              let argsMatch = true;
              for (let i = 0; i < expr.args.length; i++) {
                const exprArg = expr.args[i];
                const aggArg = aggFuncNode.args[i];
                // Simple check: if both are column references, check names match
                if (exprArg.type === 'column' && (aggArg as any).expression?.type === 'column') {
                  if (exprArg.name.toLowerCase() !== (aggArg as any).expression.name.toLowerCase()) {
                    argsMatch = false;
                    break;
                  }
                } else if (exprArg.type === 'literal' && (aggArg as any).expression?.type === 'literal') {
                  if (exprArg.value !== (aggArg as any).expression.value) {
                    argsMatch = false;
                    break;
                  }
                }
                // For other cases, we'd need more sophisticated comparison
              }

              if (argsMatch) {
                // Found matching aggregate - return a column reference to it
                const columnExpr: AST.ColumnExpr = {
                  type: 'column',
                  name: agg.alias
                };
                return new ColumnReferenceNode(
                  ctx.scope,
                  columnExpr,
                  agg.expression.getType(),
                  agg.attributeId,
                  agg.columnIndex
                );
              }
            }
          }
        }
      }

      const funcResolution = resolveFunction(ctx.scope, expr);
      if (!funcResolution || funcResolution === Ambiguous) {
        throw new QuereusError(`Function not found/ambiguous: ${expr.name}/${expr.args.length}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }

      // Check if this is an aggregate function
      const functionSchema = (funcResolution as any).functionSchema;
      if (functionSchema && isAggregateFunctionSchema(functionSchema)) {
        if (!allowAggregates) {
          throw new QuereusError(`Aggregate function ${expr.name} not allowed in this context`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
        }

        // Build arguments for aggregate function
        const args = expr.args.map(arg => buildExpression(ctx, arg, false)); // Aggregates can't contain other aggregates

        return new AggregateFunctionCallNode(
          ctx.scope,
          expr,
          expr.name,
          functionSchema,
          args,
          expr.distinct ?? false, // Use the distinct field from the AST
          undefined, // orderBy - TODO: parse from expr
          undefined  // filter - TODO: parse from expr
        );
      } else {
        // Regular scalar function
        const args = expr.args.map(arg => buildExpression(ctx, arg, allowAggregates));
        return new ScalarFunctionCallNode(ctx.scope, expr, functionSchema.returnType, args);
      }
    case 'subquery':
       // For scalar subqueries, create a context that allows correlation
       // The buildSelectStmt will create the proper scope chain with subquery tables taking precedence
       const subqueryContext = { ...ctx };
       const subqueryPlan = buildSelectStmt(subqueryContext, expr.query);
       if (subqueryPlan.getType().typeClass !== 'relation') {
         throw new QuereusError('Subquery must produce a relation', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }
       return new ScalarSubqueryNode(ctx.scope, expr, subqueryPlan as RelationalPlanNode);
    case 'in':
       // Build the left expression
       const leftExpr = buildExpression(ctx, expr.expr, allowAggregates);

       if (expr.subquery) {
         // IN subquery: expr IN (SELECT ...)
         const inSubqueryContext = { ...ctx };
         const inSubqueryPlan = buildSelectStmt(inSubqueryContext, expr.subquery);
         if (inSubqueryPlan.getType().typeClass !== 'relation') {
           throw new QuereusError('IN subquery must produce a relation', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
         }
                   return new InNode(ctx.scope, expr, leftExpr, inSubqueryPlan as RelationalPlanNode);
               } else if (expr.values) {
          // IN value list: expr IN (value1, value2, ...)
          const valueExprs = expr.values.map(val => buildExpression(ctx, val, allowAggregates));
          // Create a special IN node for value lists
          // Import the InNode from subquery module
          return new InNode(ctx.scope, expr, leftExpr, undefined, valueExprs);
       } else {
         throw new QuereusError('IN expression must have either values or subquery', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }
    default:
      throw new QuereusError(`Expression type '${(expr as any).type}' not yet supported in buildExpression.`, StatusCode.UNSUPPORTED, undefined, expr.loc?.start.line, expr.loc?.start.column);
  }
}
