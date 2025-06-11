import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DeleteNode } from '../nodes/delete-node.js';
import { buildTableReference, buildTableScan } from './table.js';
import { buildExpression } from './expression.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type RowDescriptor } from '../nodes/plan-node.js';
import { FilterNode } from '../nodes/filter.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOp } from '../../schema/table.js';
import { ReturningNode } from '../nodes/returning-node.js';

export function buildDeleteStmt(
  ctx: PlanningContext,
  stmt: AST.DeleteStmt,
): PlanNode {
  const tableReference = buildTableReference({ type: 'table', table: stmt.table }, ctx);

  // Plan the source of rows to delete. This is typically the table itself, potentially filtered.
  let sourceNode: RelationalPlanNode = buildTableScan({ type: 'table', table: stmt.table }, ctx);

  // Create a new scope with the table columns registered for column resolution
  const tableScope = new RegisteredScope(ctx.scope);
  const sourceAttributes = sourceNode.getAttributes();
  sourceNode.getType().columns.forEach((c, i) => {
    const attr = sourceAttributes[i];
    tableScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
      new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
  });

  // Create a new planning context with the updated scope for WHERE clause resolution
  const deleteCtx = { ...ctx, scope: tableScope };

  if (stmt.where) {
    const filterExpression = buildExpression(deleteCtx, stmt.where);
    sourceNode = new FilterNode(deleteCtx.scope, sourceNode, filterExpression);
  }

  // Always inject ConstraintCheckNode for DELETE operations
  // Checks constraints (like foreign key references) before deletion
  const constraintCheckNode = new ConstraintCheckNode(
    deleteCtx.scope,
    sourceNode,
    tableReference,
    RowOp.DELETE,
    undefined, // oldRowDescriptor - not needed for DELETE constraint checking
    undefined  // newRowDescriptor - not needed for DELETE
  );

  const deleteNode = new DeleteNode(
    deleteCtx.scope,
    tableReference,
    constraintCheckNode, // Use constraint-checked rows as source
  );

  let resultNode: RelationalPlanNode = deleteNode;

  if (stmt.returning && stmt.returning.length > 0) {
    const returningProjections = stmt.returning.map(rc => {
			// TODO: RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);
      return { node: buildExpression(deleteCtx, rc.expr) as ScalarPlanNode, alias: rc.alias };
    });
    // Similar to UPDATE, using sourceNode (the filtered rows to be deleted) as a stand-in for RETURNING.
    // The emitter needs to provide the *actual* deleted rows.
    return new ReturningNode(deleteCtx.scope, resultNode, returningProjections);
  }

	return new SinkNode(deleteCtx.scope, resultNode, 'delete');
}
