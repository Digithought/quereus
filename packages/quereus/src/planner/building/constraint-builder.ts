import type { PlanningContext } from '../planning-context.js';
import type { TableSchema, RowConstraintSchema } from '../../schema/table.js';
import type { RowOpFlag } from '../../schema/table.js';
import type { Attribute, RowDescriptor } from '../nodes/plan-node.js';
import type { ConstraintCheck } from '../nodes/constraint-check-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { buildExpression } from './expression.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import * as AST from '../../parser/ast.js';

/**
 * Determines if a constraint should be checked for the given operation
 */
function shouldCheckConstraint(constraint: RowConstraintSchema, operation: RowOpFlag): boolean {
  // Check if the current operation is in the constraint's operations bitmask
  return (constraint.operations & operation) !== 0;
}

/**
 * Builds constraint check expressions at plan time.
 * This allows the optimizer to see and optimize constraint expressions.
 */
export function buildConstraintChecks(
  ctx: PlanningContext,
  tableSchema: TableSchema,
  operation: RowOpFlag,
  oldAttributes: Attribute[],
  newAttributes: Attribute[],
  _flatRowDescriptor: RowDescriptor
): ConstraintCheck[] {
  // Build attribute ID mappings for column registration
  const newAttrIdByCol: Record<string, number> = {};
  const oldAttrIdByCol: Record<string, number> = {};

  newAttributes.forEach((attr, columnIndex) => {
    if (columnIndex < tableSchema.columns.length) {
      const column = tableSchema.columns[columnIndex];
      newAttrIdByCol[column.name.toLowerCase()] = attr.id;
    }
  });

  oldAttributes.forEach((attr, columnIndex) => {
    if (columnIndex < tableSchema.columns.length) {
      const column = tableSchema.columns[columnIndex];
      oldAttrIdByCol[column.name.toLowerCase()] = attr.id;
    }
  });

  // Filter constraints by operation
  const applicableConstraints = tableSchema.checkConstraints
    .filter(constraint => shouldCheckConstraint(constraint, operation));

  // Build expression nodes for each constraint
  return applicableConstraints.map(constraint => {
    // Create scope with OLD/NEW column access for constraint evaluation
    const constraintScope = new RegisteredScope(ctx.scope);

    // Register column symbols (similar to current emitConstraintCheck logic)
    tableSchema.columns.forEach((tableColumn, tableColIndex) => {
      const colNameLower = tableColumn.name.toLowerCase();

      // Register NEW.col and unqualified col (defaults to NEW for INSERT/UPDATE, OLD for DELETE)
      const newAttrId = newAttrIdByCol[colNameLower];
      if (newAttrId !== undefined) {
        const newColumnType = {
          typeClass: 'scalar' as const,
          affinity: tableColumn.affinity,
          nullable: !tableColumn.notNull,
          isReadOnly: false
        };

        // NEW.column
        constraintScope.registerSymbol(`new.${colNameLower}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttrId, tableColIndex));

        // For INSERT/UPDATE, unqualified column defaults to NEW
        if (operation === 1 || operation === 2) { // INSERT or UPDATE
          constraintScope.registerSymbol(colNameLower, (exp, s) =>
            new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttrId, tableColIndex));
        }
      }

      // Register OLD.col
      const oldAttrId = oldAttrIdByCol[colNameLower];
      if (oldAttrId !== undefined) {
        const oldColumnType = {
          typeClass: 'scalar' as const,
          affinity: tableColumn.affinity,
          nullable: true, // OLD values can be NULL (especially for INSERT)
          isReadOnly: false
        };

        // OLD.column
        constraintScope.registerSymbol(`old.${colNameLower}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttrId, tableColIndex));

        // For DELETE, unqualified column defaults to OLD
        if (operation === 4) { // DELETE
          constraintScope.registerSymbol(colNameLower, (exp, s) =>
            new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttrId, tableColIndex));
        }
      }
    });

    // Build the constraint expression using the specialized scope
    // Temporarily set the current schema to match the table's schema
    // This ensures unqualified table references in CHECK constraints resolve correctly
    const originalCurrentSchema = ctx.schemaManager.getCurrentSchemaName();
    const needsSchemaSwitch = tableSchema.schemaName !== originalCurrentSchema;

    if (needsSchemaSwitch) {
      ctx.schemaManager.setCurrentSchema(tableSchema.schemaName);
    }

    try {
      const expression = buildExpression(
        { ...ctx, scope: constraintScope },
        constraint.expr
      ) as ScalarPlanNode;

      // Heuristic: auto-defer if the expression contains a subquery
      // or references a different relation via attribute bindings (NEW/OLD already localized).
      const needsDeferred = containsSubquery(expression);

      return {
        constraint,
        expression,
        deferrable: needsDeferred,
        initiallyDeferred: needsDeferred,
        containsSubquery: needsDeferred
      } satisfies ConstraintCheck;
    } finally {
      // Restore original schema context
      if (needsSchemaSwitch) {
        ctx.schemaManager.setCurrentSchema(originalCurrentSchema);
      }
    }
  });
}

function containsSubquery(expr: ScalarPlanNode): boolean {
  const stack: ScalarPlanNode[] = [expr];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === PlanNodeType.ScalarSubquery || n.nodeType === PlanNodeType.Exists) {
      return true;
    }
    for (const c of n.getChildren()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stack.push(c as any);
    }
  }
  return false;
}
