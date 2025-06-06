import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { UpdateNode, type UpdateAssignment } from '../nodes/update-node.js';
import { UpdateExecutorNode } from '../nodes/update-executor-node.js';
import { buildTableReference, buildTableScan } from './table.js';
import { buildExpression } from './expression.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type RowDescriptor } from '../nodes/plan-node.js';
import { FilterNode } from '../nodes/filter.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { ProjectNode } from '../nodes/project-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';

export function buildUpdateStmt(
  ctx: PlanningContext,
  stmt: AST.UpdateStmt,
): PlanNode {
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

  // For constraint checking we now rely on the optimizer rule – do not wrap here.
  const updateExecutorNode = new UpdateExecutorNode(
    updateCtx.scope,
    updateNode, // pass raw update node – optimizer will inject ConstraintCheckNode when needed
    tableReference
  );

  if (stmt.returning && stmt.returning.length > 0) {
    // For RETURNING, create coordinated attribute IDs like we do for INSERT
    const newRowDescriptor: RowDescriptor = [];
    const returningScope = new RegisteredScope(updateCtx.scope);

    // Create consistent attribute IDs for all table columns
    const columnAttributeIds: number[] = [];
    tableReference.tableSchema.columns.forEach((tableColumn, columnIndex) => {
      const attributeId = PlanNode.nextAttrId();
      columnAttributeIds[columnIndex] = attributeId;
      newRowDescriptor[attributeId] = columnIndex;

      // Register the unqualified column name in the RETURNING scope
      returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) => {
        return new ColumnReferenceNode(
          s,
          exp as AST.ColumnExpr,
          {
            typeClass: 'scalar',
            affinity: tableColumn.affinity,
            nullable: !tableColumn.notNull,
            isReadOnly: false
          },
          attributeId,
          columnIndex
        );
      });

      // Also register the table-qualified form (table.column)
      const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
      returningScope.registerSymbol(tblQualified, (exp, s) =>
        new ColumnReferenceNode(
          s,
          exp as AST.ColumnExpr,
          {
            typeClass: 'scalar',
            affinity: tableColumn.affinity,
            nullable: !tableColumn.notNull,
            isReadOnly: false
          },
          attributeId,
          columnIndex
        )
      );
    });

    const returningProjections = stmt.returning.map(rc => {
      // TODO: Support RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);

      // Infer alias from column name if not explicitly provided
      let alias = rc.alias;
      if (!alias && rc.expr.type === 'column') {
        alias = rc.expr.name;
      }

      return {
        node: buildExpression({ ...updateCtx, scope: returningScope }, rc.expr) as ScalarPlanNode,
        alias: alias
      };
    });

    // Create UpdateNode with the row descriptor for RETURNING coordination
    const updateNodeWithDescriptor = new UpdateNode(
      updateCtx.scope,
      tableReference,
      assignments,
      sourceNode,
      stmt.onConflict,
      undefined, // oldRowDescriptor - will be set by optimizer if needed
      newRowDescriptor
    );

    // Project from the UpdateNode before execution – optimizer will ensure correct wrapping.
    return new ProjectNode(updateCtx.scope, updateNodeWithDescriptor, returningProjections);
  }

  return new SinkNode(updateCtx.scope, updateExecutorNode, 'update');
}
