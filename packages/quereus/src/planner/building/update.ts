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

/**
 * Validates that RETURNING expressions use appropriate NEW/OLD qualifiers for the operation type
 */
function validateReturningExpression(expr: AST.Expression, operationType: 'INSERT' | 'UPDATE' | 'DELETE'): void {
	function checkExpression(e: AST.Expression): void {
		if (e.type === 'column') {
			if (e.table?.toLowerCase() === 'old' && operationType === 'INSERT') {
				throw new QuereusError(
					'OLD qualifier cannot be used in INSERT RETURNING clause',
					StatusCode.ERROR
				);
			}
			if (e.table?.toLowerCase() === 'new' && operationType === 'DELETE') {
				throw new QuereusError(
					'NEW qualifier cannot be used in DELETE RETURNING clause',
					StatusCode.ERROR
				);
			}
		} else if (e.type === 'binary') {
			checkExpression(e.left);
			checkExpression(e.right);
		} else if (e.type === 'unary') {
			checkExpression(e.expr);
		} else if (e.type === 'function') {
			e.args.forEach(checkExpression);
		} else if (e.type === 'case') {
			if (e.baseExpr) checkExpression(e.baseExpr);
			e.whenThenClauses.forEach(clause => {
				checkExpression(clause.when);
				checkExpression(clause.then);
			});
			if (e.elseExpr) checkExpression(e.elseExpr);
		} else if (e.type === 'cast') {
			checkExpression(e.expr);
		} else if (e.type === 'collate') {
			checkExpression(e.expr);
		} else if (e.type === 'subquery') {
			// Subqueries in RETURNING are complex - for now, we'll skip validation
			// A full implementation would need to traverse the subquery's AST
		} else if (e.type === 'in') {
			checkExpression(e.expr);
			if (e.values) {
				e.values.forEach(checkExpression);
			}
		} else if (e.type === 'exists') {
			// EXISTS subqueries are complex - skip validation for now
		} else if (e.type === 'windowFunction') {
			checkExpression(e.function);
		}
		// Other expression types (literal, parameter) don't need validation
	}

	checkExpression(expr);
}

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
    const oldRowDescriptor: RowDescriptor = [];
    const returningScope = new RegisteredScope(updateCtx.scope);

    // Create consistent attribute IDs for all table columns (both NEW and OLD)
    const newColumnAttributeIds: number[] = [];
    const oldColumnAttributeIds: number[] = [];
    tableReference.tableSchema.columns.forEach((tableColumn, columnIndex) => {
      const newAttributeId = PlanNode.nextAttrId();
      const oldAttributeId = PlanNode.nextAttrId();
      newColumnAttributeIds[columnIndex] = newAttributeId;
      oldColumnAttributeIds[columnIndex] = oldAttributeId;
      newRowDescriptor[newAttributeId] = columnIndex;
      oldRowDescriptor[oldAttributeId] = columnIndex;

      // Register the unqualified column name in the RETURNING scope (defaults to NEW values)
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
          newAttributeId,
          columnIndex
        );
      });

      // Also register the table-qualified form (table.column) - defaults to NEW values
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
          newAttributeId,
          columnIndex
        )
      );

      // Register NEW.column for UPDATE RETURNING (updated values)
      returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(
          s,
          exp as AST.ColumnExpr,
          {
            typeClass: 'scalar',
            affinity: tableColumn.affinity,
            nullable: !tableColumn.notNull,
            isReadOnly: false
          },
          newAttributeId,
          columnIndex
        )
      );

      // Register OLD.column for UPDATE RETURNING (original values)
      returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(
          s,
          exp as AST.ColumnExpr,
          {
            typeClass: 'scalar',
            affinity: tableColumn.affinity,
            nullable: !tableColumn.notNull,
            isReadOnly: false
          },
          oldAttributeId,
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
        // For qualified column references like NEW.id or OLD.id, normalize to lowercase
        if (rc.expr.table) {
          alias = `${rc.expr.table.toLowerCase()}.${rc.expr.name.toLowerCase()}`;
        } else {
          alias = rc.expr.name.toLowerCase();
        }
      }

      // Validate RETURNING expression (UPDATE supports both NEW and OLD)
      validateReturningExpression(rc.expr, 'UPDATE');

      return {
        node: buildExpression({ ...updateCtx, scope: returningScope }, rc.expr) as ScalarPlanNode,
        alias: alias
      };
    });

    // Create UpdateNode with both row descriptors for RETURNING coordination
    const updateNodeWithDescriptor = new UpdateNode(
      updateCtx.scope,
      tableReference,
      assignments,
      sourceNode,
      stmt.onConflict,
      oldRowDescriptor, // oldRowDescriptor - needed for OLD references
      newRowDescriptor
    );

    // For returning, we still need to execute the update before projecting
    // Always inject ConstraintCheckNode for UPDATE operations (provides required metadata)
    const constraintCheckNode = new ConstraintCheckNode(
      updateCtx.scope,
      updateNodeWithDescriptor,
      tableReference,
      RowOp.UPDATE,
      oldRowDescriptor, // oldRowDescriptor - needed for OLD references in constraints and RETURNING
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
