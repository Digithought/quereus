import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { AddConstraintNode } from '../nodes/add-constraint-node.js';
import { AlterTableNode } from '../nodes/alter-table-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { VoidNode } from '../nodes/plan-node.js';

export function buildAlterTableStmt(
  ctx: PlanningContext,
  stmt: AST.AlterTableStmt,
): VoidNode {
  const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, ctx);
  const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

  switch (stmt.action.type) {
    case 'addConstraint': {
      // Convert RowOp[] (e.g., ['insert','update']) to bitmask understood by runtime.
      const operations = stmt.action.constraint.operations ?? ['insert','update'];

      const constraintWithBitmask = {
        ...stmt.action.constraint,
        operations
      };

      return new AddConstraintNode(
        ctx.scope,
        tableReference,
        constraintWithBitmask
      );
		}

    case 'renameTable':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'renameTable',
        newName: stmt.action.newName,
      });

    case 'renameColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'renameColumn',
        oldName: stmt.action.oldName,
        newName: stmt.action.newName,
      });

    case 'addColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'addColumn',
        column: stmt.action.column,
      });

    case 'dropColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'dropColumn',
        name: stmt.action.name,
      });

    case 'alterPrimaryKey':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'alterPrimaryKey',
        columns: stmt.action.columns,
      });

    default:
      throw new QuereusError(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `Unknown ALTER TABLE action: ${(stmt.action as any).type}`,
        StatusCode.INTERNAL
      );
  }
}
