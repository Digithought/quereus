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
import { buildOldNewRowDescriptors } from '../../util/row-descriptor.js';

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

  // Create OLD/NEW attributes for DELETE (OLD = actual values being deleted, NEW = all NULL)
  const oldAttributes = tableReference.tableSchema.columns.map((col, index) => ({
    id: PlanNode.nextAttrId(),
    name: col.name,
    type: {
      typeClass: 'scalar' as const,
      affinity: col.affinity,
      nullable: !col.notNull,
      isReadOnly: false
    },
    sourceRelation: `OLD.${tableReference.tableSchema.name}`
  }));

  const newAttributes = tableReference.tableSchema.columns.map((col, index) => ({
    id: PlanNode.nextAttrId(),
    name: col.name,
    type: {
      typeClass: 'scalar' as const,
      affinity: col.affinity,
      nullable: true, // NEW values are always NULL for DELETE
      isReadOnly: false
    },
    sourceRelation: `NEW.${tableReference.tableSchema.name}`
  }));

  const { oldRowDescriptor, newRowDescriptor } = buildOldNewRowDescriptors(oldAttributes, newAttributes);

  // Always inject ConstraintCheckNode for DELETE operations
  const constraintCheckNode = new ConstraintCheckNode(
    deleteCtx.scope,
    sourceNode,
    tableReference,
    RowOp.DELETE,
    oldRowDescriptor,
    newRowDescriptor
  );

  const deleteNode = new DeleteNode(
    deleteCtx.scope,
    tableReference,
    constraintCheckNode, // Use constraint-checked rows as source
  );

  const resultNode: RelationalPlanNode = deleteNode;

  if (stmt.returning && stmt.returning.length > 0) {
    // Create returning scope with OLD/NEW attribute access
    const returningScope = new RegisteredScope(deleteCtx.scope);

    // Register OLD.* symbols (actual values being deleted)
    oldAttributes.forEach((attr, columnIndex) => {
      const tableColumn = tableReference.tableSchema.columns[columnIndex];
      returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
      );
    });

    // Register NEW.* symbols (always NULL for DELETE) and unqualified column names (default to OLD for DELETE)
    newAttributes.forEach((attr, columnIndex) => {
      const tableColumn = tableReference.tableSchema.columns[columnIndex];

      // NEW.column (always NULL for DELETE)
      returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
      );

      // Unqualified column (defaults to OLD for DELETE)
      const oldAttr = oldAttributes[columnIndex];
      returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldAttr.type, oldAttr.id, columnIndex)
      );

      // Table-qualified form (table.column -> OLD for DELETE)
      const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
      returningScope.registerSymbol(tblQualified, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldAttr.type, oldAttr.id, columnIndex)
      );
    });

    // Build RETURNING projections in the OLD/NEW context
    const returningProjections = stmt.returning.map(rc => {
      // TODO: Support RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);

      // Infer alias from column name if not explicitly provided
      let alias = rc.alias;
      if (!alias && rc.expr.type === 'column') {
        alias = rc.expr.name;
      }

      return {
        node: buildExpression({ ...deleteCtx, scope: returningScope }, rc.expr) as ScalarPlanNode,
        alias: alias
      };
    });

    return new ReturningNode(deleteCtx.scope, resultNode, returningProjections);
  }

	return new SinkNode(deleteCtx.scope, resultNode, 'delete');
}
