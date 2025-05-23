import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DeleteNode } from '../nodes/delete-node.js';
import { buildTableReference, buildTableScan } from './table.js';
import { buildExpression } from './expression.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { FilterNode } from '../nodes/filter-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { ProjectNode } from '../nodes/project-node.js';

export function buildDeleteStmt(
  ctx: PlanningContext,
  stmt: AST.DeleteStmt,
): RelationalPlanNode {
  const tableReference = buildTableReference({ type: 'table', table: stmt.table }, ctx);

  // Plan the source of rows to delete. This is typically the table itself, potentially filtered.
  let sourceNode: RelationalPlanNode = buildTableScan({ type: 'table', table: stmt.table }, ctx);

  if (stmt.where) {
    const filterExpression = buildExpression(ctx, stmt.where);
    sourceNode = new FilterNode(ctx.scope, sourceNode, filterExpression);
  }

  const deleteNode = new DeleteNode(
    ctx.scope,
    tableReference,
    sourceNode,
  );

  if (stmt.returning && stmt.returning.length > 0) {
    const returningProjections = stmt.returning.map(rc => {
			// TODO: RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);
      return { node: buildExpression(ctx, rc.expr) as ScalarPlanNode, alias: rc.alias };
    });
    // Similar to UPDATE, using sourceNode (the filtered rows to be deleted) as a stand-in for RETURNING.
    // The emitter needs to provide the *actual* deleted rows.
    return new ProjectNode(ctx.scope, deleteNode, returningProjections);
  }

	return deleteNode;
}
