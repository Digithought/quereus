import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { LiteralNode, BinaryOpNode, UnaryOpNode, CaseExprNode, CastNode, CollateNode, BetweenNode } from '../nodes/scalar.js';
import { ScalarSubqueryNode, InNode, ExistsNode } from '../nodes/subquery.js';
import { WindowFunctionCallNode } from '../nodes/window-function.js';
import type { ScalarPlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { RelationType } from '../../common/datatype.js';
import { resolveColumn, resolveParameter } from '../resolve.js';
import { Ambiguous } from '../scopes/scope.js';
import { buildSelectStmt } from './select.js';
import { resolveWindowFunction } from '../../schema/window-function.js';
import { buildFunctionCall } from './function-call.js';

export function buildExpression(ctx: PlanningContext, expr: AST.Expression, allowAggregates: boolean = false): ScalarPlanNode {
  switch (expr.type) {
    case 'literal':
      return new LiteralNode(ctx.scope, expr);

    case 'column': {
      const colResolution = resolveColumn(ctx.scope, expr, ctx.db.schemaManager.getCurrentSchemaName());

      if (!colResolution || colResolution === Ambiguous) {
        throw new QuereusError(`Column not found: ${expr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      return colResolution as ScalarPlanNode;
		}

		case 'parameter': {
      const paramResolution = resolveParameter(ctx.scope, expr);
      if (!paramResolution || paramResolution === Ambiguous) {
        throw new QuereusError(`Parameter not found: ${expr.name ?? expr.index}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      return paramResolution as ScalarPlanNode;
		}

		case 'unary': {
      // Optimization: fold unary minus over numeric literals into negative literals
      if (expr.operator === '-' && expr.expr.type === 'literal') {
        const literalExpr = expr.expr as AST.LiteralExpr;
        if (typeof literalExpr.value === 'number' || typeof literalExpr.value === 'bigint') {
          // Create a new literal expression with the negated value
          const negatedLiteral: AST.LiteralExpr = {
            type: 'literal',
            value: typeof literalExpr.value === 'bigint' ? -literalExpr.value : -literalExpr.value,
            lexeme: literalExpr.lexeme ? `-${literalExpr.lexeme}` : undefined,
            loc: expr.loc // Use the location of the entire unary expression
          };
          return new LiteralNode(ctx.scope, negatedLiteral);
        }
      }

      const operand = buildExpression(ctx, expr.expr, allowAggregates);
      return new UnaryOpNode(ctx.scope, expr, operand);
		}

		case 'binary': {
      const left = buildExpression(ctx, expr.left, allowAggregates);
      const right = buildExpression(ctx, expr.right, allowAggregates);
      return new BinaryOpNode(ctx.scope, expr, left, right);
		}

    case 'case': {
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
		}

    case 'cast': {
      const castOperand = buildExpression(ctx, expr.expr, allowAggregates);
      return new CastNode(ctx.scope, expr, castOperand);
    }

    case 'collate': {
      const collateOperand = buildExpression(ctx, expr.expr, allowAggregates);
      return new CollateNode(ctx.scope, expr, collateOperand);
    }

		case 'function': return buildFunctionCall(ctx, expr, allowAggregates);

    case 'subquery': {
       // For scalar subqueries, create a context that allows correlation
       // The buildSelectStmt will create the proper scope chain with subquery tables taking precedence
       const subqueryContext = { ...ctx };
       const subqueryPlan = buildSelectStmt(subqueryContext, expr.query, ctx.cteNodes);
       if (subqueryPlan.getType().typeClass !== 'relation') {
         throw new QuereusError('Subquery must produce a relation', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }
       // Validate that scalar subquery returns exactly one column
       const scalarSubqueryType = subqueryPlan.getType();
       if (scalarSubqueryType.typeClass === 'relation' && (scalarSubqueryType as RelationType).columns.length !== 1) {
         throw new QuereusError('Scalar subquery must return exactly one column', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }
       return new ScalarSubqueryNode(ctx.scope, expr, subqueryPlan as RelationalPlanNode);
		}

		case 'windowFunction': {
       // Window functions are handled by creating a WindowFunctionCallNode
       // First validate that this is a registered window function
       const windowSchema = resolveWindowFunction(expr.function.name);
       if (!windowSchema) {
         throw new QuereusError(`Unknown window function: ${expr.function.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }

       // Validate argument count (special case for COUNT(*))
       const isCountStar = expr.function.name.toLowerCase() === 'count' && expr.function.args.length === 0;
       if (windowSchema.argCount !== 'variadic' && expr.function.args.length !== windowSchema.argCount && !isCountStar) {
         throw new QuereusError(`Window function ${expr.function.name} expects ${windowSchema.argCount} arguments, got ${expr.function.args.length}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }

       // Validate ORDER BY requirement
       if (windowSchema.requiresOrderBy && (!expr.window?.orderBy || expr.window.orderBy.length === 0)) {
         throw new QuereusError(`Window function ${expr.function.name} requires ORDER BY clause`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }

       return new WindowFunctionCallNode(
         ctx.scope,
         expr,
         expr.function.name,
         expr.function.distinct ?? false
       );
		}

		case 'in': {
       // Build the left expression
       const leftExpr = buildExpression(ctx, expr.expr, allowAggregates);

       if (expr.subquery) {
         // IN subquery: expr IN (SELECT ...)
         const inSubqueryContext = { ...ctx };
         const inSubqueryPlan = buildSelectStmt(inSubqueryContext, expr.subquery, ctx.cteNodes);
         if (inSubqueryPlan.getType().typeClass !== 'relation') {
           throw new QuereusError('IN subquery must produce a relation', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
         }
         // Validate that subquery returns exactly one column
         const subqueryType = inSubqueryPlan.getType();
         if (subqueryType.typeClass === 'relation' && (subqueryType as RelationType).columns.length !== 1) {
           throw new QuereusError('IN subquery must return exactly one column', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
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
		}

    case 'exists': {
       // Build the EXISTS subquery
       const existsSubqueryContext = { ...ctx };
       const existsSubqueryPlan = buildSelectStmt(existsSubqueryContext, expr.subquery, ctx.cteNodes);
       if (existsSubqueryPlan.getType().typeClass !== 'relation') {
         throw new QuereusError('EXISTS subquery must produce a relation', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }
       return new ExistsNode(ctx.scope, expr, existsSubqueryPlan as RelationalPlanNode);
		}

    case 'between': {
       // Build the BETWEEN expression: expr BETWEEN lower AND upper
       const exprNode = buildExpression(ctx, expr.expr, allowAggregates);
       const lowerNode = buildExpression(ctx, expr.lower, allowAggregates);
       const upperNode = buildExpression(ctx, expr.upper, allowAggregates);
       return new BetweenNode(ctx.scope, expr, exprNode, lowerNode, upperNode);
		}

		default:
      throw new QuereusError(`Expression type '${(expr as any).type}' not yet supported in buildExpression.`, StatusCode.UNSUPPORTED, undefined, expr.loc?.start.line, expr.loc?.start.column);
  }
}
