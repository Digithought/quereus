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
  // Create oldRowDescriptor for constraint checking with OLD references
  const oldRowDescriptor: RowDescriptor = [];
  tableReference.tableSchema.columns.forEach((tableColumn, columnIndex) => {
    const oldAttributeId = PlanNode.nextAttrId();
    oldRowDescriptor[oldAttributeId] = columnIndex;
  });

  // Checks constraints (like foreign key references) before deletion
  const constraintCheckNode = new ConstraintCheckNode(
    deleteCtx.scope,
    sourceNode,
    tableReference,
    RowOp.DELETE,
    oldRowDescriptor, // oldRowDescriptor - needed for OLD references in DELETE constraints
    undefined  // newRowDescriptor - not needed for DELETE
  );

  const deleteNode = new DeleteNode(
    deleteCtx.scope,
    tableReference,
    constraintCheckNode, // Use constraint-checked rows as source
  );

  let resultNode: RelationalPlanNode = deleteNode;

  if (stmt.returning && stmt.returning.length > 0) {
    // For DELETE RETURNING, reuse the existing OLD row descriptor from constraint checking
    const returningScope = new RegisteredScope(deleteCtx.scope);

    // Reuse the existing attribute IDs from the constraint check oldRowDescriptor
    tableReference.tableSchema.columns.forEach((tableColumn, columnIndex) => {
      // Find the existing attribute ID for this column from the constraint check oldRowDescriptor
      let oldAttributeId: number | undefined;
      for (const attrIdStr in oldRowDescriptor) {
        const attrId = parseInt(attrIdStr);
        if (oldRowDescriptor[attrId] === columnIndex) {
          oldAttributeId = attrId;
          break;
        }
      }

      if (oldAttributeId === undefined) {
        throw new Error(`Could not find attribute ID for column ${columnIndex} in oldRowDescriptor`);
      }

      // Register the unqualified column name in the RETURNING scope (defaults to OLD values for DELETE)
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
          oldAttributeId,
          columnIndex
        );
      });

      // Also register the table-qualified form (table.column) - defaults to OLD values for DELETE
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
          oldAttributeId,
          columnIndex
        )
      );

      // Register OLD.column for DELETE RETURNING (deleted values)
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
      // TODO: RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);

      // Infer alias from column name if not explicitly provided
      let alias = rc.alias;
      if (!alias && rc.expr.type === 'column') {
        // For qualified column references like OLD.id, preserve the full qualified name
        if (rc.expr.table) {
          alias = `${rc.expr.table}.${rc.expr.name}`;
        } else {
          alias = rc.expr.name;
        }
      }

      // Validate that NEW references are not used in DELETE RETURNING
      validateReturningExpression(rc.expr, 'DELETE');

      return { 
        node: buildExpression({ ...deleteCtx, scope: returningScope }, rc.expr) as ScalarPlanNode, 
        alias: alias 
      };
    });

    // Update the DeleteNode to include the OLD row descriptor for RETURNING (reuse existing one)
    const deleteNodeWithDescriptor = new DeleteNode(
      deleteCtx.scope,
      tableReference,
      constraintCheckNode, // Use constraint-checked rows as source
      oldRowDescriptor // Reuse the same OLD row descriptor from constraint checking
    );

    // Similar to UPDATE, using sourceNode (the filtered rows to be deleted) as a stand-in for RETURNING.
    // The emitter needs to provide the *actual* deleted rows.
    return new ReturningNode(deleteCtx.scope, deleteNodeWithDescriptor, returningProjections);
  }

	return new SinkNode(deleteCtx.scope, resultNode, 'delete');
}
