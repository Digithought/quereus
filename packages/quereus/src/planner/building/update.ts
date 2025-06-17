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
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOp } from '../../schema/table.js';
import { ReturningNode } from '../nodes/returning-node.js';

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

      const columnIndex = tableReference.tableSchema.columns.findIndex(col => col.name.toLowerCase() === (rc.expr.type === 'column' ? rc.expr.name.toLowerCase() : ''));
      const projAttributeId = rc.expr.type === 'column' && columnIndex !== -1 ? columnAttributeIds[columnIndex] : undefined;

      return {
        node: buildExpression({ ...updateCtx, scope: returningScope }, rc.expr) as ScalarPlanNode,
        alias: alias,
        attributeId: projAttributeId
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

    // For returning, we still need to execute the update before projecting
    // Always inject ConstraintCheckNode for UPDATE operations (provides required metadata)
    const constraintCheckNode = new ConstraintCheckNode(
      updateCtx.scope,
      updateNodeWithDescriptor,
      tableReference,
      RowOp.UPDATE,
      undefined, // oldRowDescriptor - UpdateNode already handles old row metadata
      newRowDescriptor
    );

    const updateExecutorNode = new UpdateExecutorNode(
      updateCtx.scope,
      constraintCheckNode,
      tableReference
    );

    // Return the RETURNING results from the executed update
    return new ReturningNode(updateCtx.scope, updateExecutorNode, returningProjections);
  }

  // Step 1: Create UpdateNode that produces updated rows (but doesn't execute them)
  // Create newRowDescriptor and oldRowDescriptor for constraint checking with NEW/OLD references
  const newRowDescriptor: RowDescriptor = [];
  const oldRowDescriptor: RowDescriptor = [];
  tableReference.tableSchema.columns.forEach((tableColumn, columnIndex) => {
    const newAttributeId = PlanNode.nextAttrId();
    const oldAttributeId = PlanNode.nextAttrId();
    newRowDescriptor[newAttributeId] = columnIndex;
    oldRowDescriptor[oldAttributeId] = columnIndex;
  });

  const updateNode = new UpdateNode(
    updateCtx.scope,
    tableReference,
    assignments,
    sourceNode,
    stmt.onConflict,
    oldRowDescriptor,
    newRowDescriptor
  );

  // Always inject ConstraintCheckNode for UPDATE operations (provides required metadata)
  const constraintCheckNode = new ConstraintCheckNode(
    updateCtx.scope,
    updateNode,
    tableReference,
    RowOp.UPDATE,
    oldRowDescriptor, // oldRowDescriptor - needed for OLD references in constraints
    newRowDescriptor  // newRowDescriptor - needed for NEW/OLD references in constraints
  );

  const updateExecutorNode = new UpdateExecutorNode(
    updateCtx.scope,
    constraintCheckNode,
    tableReference
  );

  return new SinkNode(updateCtx.scope, updateExecutorNode, 'update');
}
