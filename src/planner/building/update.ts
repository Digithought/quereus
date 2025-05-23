import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { UpdateNode, type UpdateAssignment } from '../nodes/update-node.js';
import { buildTableReference, buildTableScan } from './table.js';
import { buildExpression } from './expression.js';
import { type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { FilterNode } from '../nodes/filter-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { ProjectNode } from '../nodes/project-node.js';

export function buildUpdateStmt(
  ctx: PlanningContext,
  stmt: AST.UpdateStmt,
): RelationalPlanNode {
  const tableReference = buildTableReference({ type: 'table', table: stmt.table }, ctx);

  // Plan the source of rows to update. This is typically the table itself, potentially filtered.
  let sourceNode: RelationalPlanNode = buildTableScan({ type: 'table', table: stmt.table }, ctx);

  if (stmt.where) {
    const filterExpression = buildExpression(ctx, stmt.where);
    sourceNode = new FilterNode(ctx.scope, sourceNode, filterExpression);
  }

  const assignments: UpdateAssignment[] = stmt.assignments.map(assign => {
    // TODO: Validate assign.column against tableReference.tableSchema
    const targetColumn: AST.ColumnExpr = { type: 'column', name: assign.column, table: stmt.table.name, schema: stmt.table.schema };
    return {
      targetColumn, // Keep as AST for now, emitter can resolve index
      value: buildExpression(ctx, assign.value),
    };
  });

  const updateNode = new UpdateNode(
    ctx.scope,
    tableReference,
    assignments,
    sourceNode,
    stmt.onConflict
  );

  if (stmt.returning && stmt.returning.length > 0) {
    const returningProjections = stmt.returning.map(rc => {
			// TODO: Support RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);
      return { node: buildExpression(ctx, rc.expr) as ScalarPlanNode, alias: rc.alias };
    });
    return new ProjectNode(ctx.scope, updateNode, returningProjections);
  }

	return updateNode;
}
