import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { InsertNode } from '../nodes/insert-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildSelectStmt } from './select.js';
import { buildWithClause } from './with.js';
import { ValuesNode } from '../nodes/values-node.js'; // Assuming ValuesNode exists or will be created
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { ProjectNode } from '../nodes/project-node.js';
import { buildExpression } from './expression.js'; // Assuming this will be created
import { checkColumnsAssignable, columnSchemaToDef } from '../type-utils.js';
import type { ColumnDef } from '../../common/datatype.js';
import type { CTEPlanNode } from '../nodes/cte-node.js';

export function buildInsertStmt(
	ctx: PlanningContext,
	stmt: AST.InsertStmt,
): RelationalPlanNode {
	const tableReference = buildTableReference({ type: 'table', table: stmt.table }, ctx);

	let targetColumns: ColumnDef[] = [];
	if (stmt.columns && stmt.columns.length > 0) {
		// Explicit columns specified
		targetColumns = stmt.columns.map((colName, index) => columnSchemaToDef(colName, tableReference.tableSchema.columns[index]));
	} else {
		// No explicit columns - default to all table columns in order
		targetColumns = tableReference.tableSchema.columns.map(col => columnSchemaToDef(col.name, col));
	}

	let sourceNode: RelationalPlanNode;
	if (stmt.values) {
		const rows = stmt.values.map(rowExprs =>
			rowExprs.map(expr => buildExpression(ctx, expr) as PlanNode as ScalarPlanNode)
		);
		// Check that there are the right number of columns in each row
		rows.forEach(row => {
			if (row.length !== targetColumns.length) {
				throw new QuereusError(`Column count mismatch in VALUES clause. Expected ${targetColumns.length} columns, got ${row.length}.`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
		});
		sourceNode = new ValuesNode(ctx.scope, rows);
	} else if (stmt.select) {
		// For INSERT ... SELECT, plan the SELECT statement
		// Handle any WITH clause attached to the INSERT so its CTEs are visible to the SELECT
		let parentCtes: Map<string, CTEPlanNode> = new Map();
		if (stmt.withClause) {
			parentCtes = buildWithClause(ctx, stmt.withClause);
		}
		const selectPlan = buildSelectStmt(ctx, stmt.select, parentCtes);
		if (selectPlan.getType().typeClass !== 'relation') {
			throw new QuereusError('SELECT statement in INSERT did not produce a relational plan.', StatusCode.INTERNAL, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}
		sourceNode = selectPlan as RelationalPlanNode;
		checkColumnsAssignable(sourceNode.getType().columns, targetColumns, stmt);
	} else {
		throw new QuereusError('INSERT statement must have a VALUES clause or a SELECT query.', StatusCode.ERROR);
	}

	const insertNode = new InsertNode(
		ctx.scope,
		tableReference,
		targetColumns,
		sourceNode,
		stmt.onConflict
	);

  if (stmt.returning && stmt.returning.length > 0) {
    const returningProjections = stmt.returning.map(rc => {
			// TODO: Support RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);
      return { node: buildExpression(ctx, rc.expr) as ScalarPlanNode, alias: rc.alias };
    });
    return new ProjectNode(ctx.scope, insertNode, returningProjections);
  }

	return insertNode;
}
