import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { AddConstraintNode } from '../nodes/add-constraint-node.js';
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
    case 'renameColumn':
    case 'addColumn':
    case 'dropColumn':
      throw new QuereusError(
        `ALTER TABLE ${stmt.action.type} is not yet implemented`,
        StatusCode.UNSUPPORTED
      );

    default:
      throw new QuereusError(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `Unknown ALTER TABLE action: ${(stmt.action as any).type}`,
        StatusCode.INTERNAL
      );
  }
}
