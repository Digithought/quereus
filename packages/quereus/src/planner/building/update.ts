import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { UpdateNode, type UpdateAssignment } from '../nodes/update-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { UpdateExecutorNode } from '../nodes/update-executor-node.js';
import { buildTableReference, buildTableScan } from './table.js';
import { buildExpression } from './expression.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type RowDescriptor, type VoidNode } from '../nodes/plan-node.js';
import { FilterNode } from '../nodes/filter.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { ProjectNode } from '../nodes/project-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { RowOp } from '../../schema/table.js';

export function buildUpdateStmt(
  ctx: PlanningContext,
  stmt: AST.UpdateStmt,
): RelationalPlanNode | VoidNode {
  const tableReference = buildTableReference({ type: 'table', table: stmt.table }, ctx);

  // Plan the source of rows to update. This is typically the table itself, potentially filtered.
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
  const updateCtx = { ...ctx, scope: tableScope };

  if (stmt.where) {
    const filterExpression = buildExpression(updateCtx, stmt.where);
    sourceNode = new FilterNode(updateCtx.scope, sourceNode, filterExpression);
  }

  const assignments: UpdateAssignment[] = stmt.assignments.map(assign => {
    // TODO: Validate assign.column against tableReference.tableSchema
    const targetColumn: AST.ColumnExpr = { type: 'column', name: assign.column, table: stmt.table.name, schema: stmt.table.schema };
    return {
      targetColumn, // Keep as AST for now, emitter can resolve index
      value: buildExpression(updateCtx, assign.value),
    };
  });

  // Step 1: Create UpdateNode that produces updated rows (but doesn't execute them)
  const updateNode = new UpdateNode(
    updateCtx.scope,
    tableReference,
    assignments,
    sourceNode,
    stmt.onConflict
  );

  // Step 2: Wrap with constraint checking if the table has constraints
  let constraintCheckedNode: RelationalPlanNode = updateNode;
  if (tableReference.tableSchema.checkConstraints.length > 0 ||
      tableReference.tableSchema.columns.some(col => col.notNull)) {

    // Create OLD and NEW row descriptors for UPDATE
    const updateAttributes = updateNode.getAttributes();

    // For UPDATE, we need both OLD and NEW descriptors
    // OLD row descriptor points to the original row structure
    const oldRowDescriptor: RowDescriptor = [];
    updateAttributes.forEach((attr, index) => {
      oldRowDescriptor[attr.id] = index;
    });

    // NEW row descriptor points to the updated row structure (same as old for UPDATE output)
    const newRowDescriptor: RowDescriptor = [];
    updateAttributes.forEach((attr, index) => {
      newRowDescriptor[attr.id] = index;
    });

    constraintCheckedNode = new ConstraintCheckNode(
      updateCtx.scope,
      updateNode,
      tableReference,
      RowOp.UPDATE,
      oldRowDescriptor,
      newRowDescriptor
    );
  }

  // Step 3: Create UpdateExecutorNode that actually performs the database updates
  const updateExecutorNode = new UpdateExecutorNode(
    updateCtx.scope,
    constraintCheckedNode,
    tableReference
  );

  if (stmt.returning && stmt.returning.length > 0) {
    const returningProjections = stmt.returning.map(rc => {
			// TODO: Support RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);
      return { node: buildExpression(updateCtx, rc.expr) as ScalarPlanNode, alias: rc.alias };
    });
    // For RETURNING, we need to project from the constraint-checked node (before execution)
    return new ProjectNode(updateCtx.scope, constraintCheckedNode, returningProjections);
  }

	return updateExecutorNode;
}
