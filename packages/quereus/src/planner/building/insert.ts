import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { InsertNode } from '../nodes/insert-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildSelectStmt } from './select.js';
import { buildWithClause } from './with.js';
import { ValuesNode } from '../nodes/values-node.js'; // Assuming ValuesNode exists or will be created
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type RowDescriptor } from '../nodes/plan-node.js';
import { ProjectNode } from '../nodes/project-node.js';
import { buildExpression } from './expression.js'; // Assuming this will be created
import { checkColumnsAssignable, columnSchemaToDef } from '../type-utils.js';
import type { ColumnDef } from '../../common/datatype.js';
import type { CTEPlanNode } from '../nodes/cte-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';

export function buildInsertStmt(
	ctx: PlanningContext,
	stmt: AST.InsertStmt,
): PlanNode {
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

		// If we're only inserting into some columns, we need to expand the VALUES to include all table columns
		// for constraint checking to work properly (omitted columns should be NULL/default)
		if (stmt.columns && stmt.columns.length < tableReference.tableSchema.columns.length) {
			// Expand each row to include all table columns
			const expandedRows = rows.map(row => {
				const expandedRow: ScalarPlanNode[] = [];

				tableReference.tableSchema.columns.forEach((tableColumn, tableColIndex) => {
					// Check if this column is in the target columns
					const targetColIndex = targetColumns.findIndex(tc => tc.name.toLowerCase() === tableColumn.name.toLowerCase());

					if (targetColIndex >= 0) {
						// This column is provided in the VALUES - use the provided value
						expandedRow.push(row[targetColIndex]);
					} else {
						// This column is omitted - use default value or NULL
						let defaultNode: ScalarPlanNode;
						if (tableColumn.defaultValue !== undefined) {
							// Use default value
							if (typeof tableColumn.defaultValue === 'object' && tableColumn.defaultValue !== null && 'type' in tableColumn.defaultValue) {
								// It's an AST.Expression - build it into a plan node
								defaultNode = buildExpression(ctx, tableColumn.defaultValue as AST.Expression) as ScalarPlanNode;
							} else {
								// Literal default value
								defaultNode = buildExpression(ctx, { type: 'literal', value: tableColumn.defaultValue }) as ScalarPlanNode;
							}
						} else {
							// No default value - use NULL
							defaultNode = buildExpression(ctx, { type: 'literal', value: null }) as ScalarPlanNode;
						}
						expandedRow.push(defaultNode);
					}
				});

				return expandedRow;
			});

			// Create column names array with all table column names
			const tableColumnNames = tableReference.tableSchema.columns.map(col => col.name);
			sourceNode = new ValuesNode(ctx.scope, expandedRows, tableColumnNames);
			// Update targetColumns to reflect all table columns since we've expanded the VALUES
			targetColumns = tableReference.tableSchema.columns.map(col => columnSchemaToDef(col.name, col));
		} else {
			// Even for full column lists, provide proper column names to VALUES node
			const tableColumnNames = targetColumns.map(col => col.name);
			sourceNode = new ValuesNode(ctx.scope, rows, tableColumnNames);
		}
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

	// Rely on optimizer for constraint checking – no wrapping here.
	let resultNode: RelationalPlanNode = insertNode;

	if (stmt.returning && stmt.returning.length > 0) {
		// For RETURNING, create a fresh set of attribute IDs that will be used
		// consistently in both the newRowDescriptor and the RETURNING projections
		const newRowDescriptor: RowDescriptor = [];
		const returningScope = new RegisteredScope(ctx.scope);

		// Create one attribute ID per table column, ensuring they're used consistently
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

		// Build RETURNING projections in the table column context
		const returningProjections = stmt.returning.map(rc => {
			// TODO: Support RETURNING *
			if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);

			// Infer alias from column name if not explicitly provided
			let alias = rc.alias;
			if (!alias && rc.expr.type === 'column') {
				alias = rc.expr.name;
			}

			return {
				node: buildExpression({ ...ctx, scope: returningScope }, rc.expr) as ScalarPlanNode,
				alias: alias
			};
		});

		// Create a new InsertNode with the row descriptor
		const insertNodeWithDescriptor = new InsertNode(
			ctx.scope,
			tableReference,
			targetColumns,
			sourceNode,
			stmt.onConflict,
			newRowDescriptor
		);

		return new ProjectNode(ctx.scope, insertNodeWithDescriptor, returningProjections);
	}

	return new SinkNode(ctx.scope, resultNode, 'insert');
}
