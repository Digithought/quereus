import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { InsertNode } from '../nodes/insert-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildSelectStmt } from './select.js';
import { buildWithClause } from './with.js';
import { ValuesNode } from '../nodes/values-node.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type RowDescriptor } from '../nodes/plan-node.js';
import { buildExpression } from './expression.js';
import { checkColumnsAssignable, columnSchemaToDef } from '../type-utils.js';
import type { ColumnDef } from '../../common/datatype.js';
import type { CTEPlanNode } from '../nodes/cte-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOp } from '../../schema/table.js';
import { ReturningNode } from '../nodes/returning-node.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';

/**
 * Creates a uniform row expansion projection that maps any relational source
 * to the target table's column structure, filling in defaults for omitted columns.
 * This ensures INSERT works orthogonally with any relational source.
 */
function createRowExpansionProjection(
	ctx: PlanningContext,
	sourceNode: RelationalPlanNode,
	targetColumns: ColumnDef[],
	tableReference: any
): RelationalPlanNode {
	const tableSchema = tableReference.tableSchema;

	// If we're inserting into all columns in table order, no expansion needed
	if (targetColumns.length === tableSchema.columns.length) {
		const allColumnsMatch = targetColumns.every((tc, i) =>
			tc.name.toLowerCase() === tableSchema.columns[i].name.toLowerCase()
		);
		if (allColumnsMatch) {
			return sourceNode; // Source already matches table structure
		}
	}

	// Create projection expressions for each table column
	const projections: Projection[] = [];
	const sourceAttributes = sourceNode.getAttributes();

	tableSchema.columns.forEach((tableColumn: any, tableColIndex: number) => {
		// Find if this table column is in the target columns
		const targetColIndex = targetColumns.findIndex(tc =>
			tc.name.toLowerCase() === tableColumn.name.toLowerCase()
		);

		if (targetColIndex >= 0) {
			// This column is provided by the source - reference the source column
			if (targetColIndex < sourceAttributes.length) {
				const sourceAttr = sourceAttributes[targetColIndex];
				// Create a column reference to the source attribute
				const columnRef = new ColumnReferenceNode(
					ctx.scope,
					{ type: 'column', name: sourceAttr.name } as AST.ColumnExpr,
					sourceAttr.type,
					sourceAttr.id,
					targetColIndex
				);
				projections.push({
					node: columnRef,
					alias: tableColumn.name
				});
			} else {
				throw new QuereusError(
					`Source has fewer columns than expected for INSERT target columns`,
					StatusCode.ERROR
				);
			}
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
			projections.push({
				node: defaultNode,
				alias: tableColumn.name
			});
		}
	});

	// Create projection node that expands source to table structure
	return new ProjectNode(ctx.scope, sourceNode, projections);
}

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
		// VALUES clause - build the VALUES node
		const rows = stmt.values.map(rowExprs =>
			rowExprs.map(expr => buildExpression(ctx, expr) as PlanNode as ScalarPlanNode)
		);

		// Check that there are the right number of columns in each row
		rows.forEach(row => {
			if (row.length !== targetColumns.length) {
				throw new QuereusError(`Column count mismatch in VALUES clause. Expected ${targetColumns.length} columns, got ${row.length}.`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
		});

		// Create VALUES node with target column names
		const targetColumnNames = targetColumns.map(col => col.name);
		sourceNode = new ValuesNode(ctx.scope, rows, targetColumnNames);

	} else if (stmt.select) {
		// SELECT clause - build the SELECT statement
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

	// ORTHOGONAL ROW EXPANSION:
	// Apply uniform row expansion to map any source to table structure with defaults
	const expandedSourceNode = createRowExpansionProjection(ctx, sourceNode, targetColumns, tableReference);

	// Update targetColumns to reflect all table columns since we've expanded the source
	const finalTargetColumns = tableReference.tableSchema.columns.map(col => columnSchemaToDef(col.name, col));

	// Always inject ConstraintCheckNode for INSERT operations
	const constraintCheckNode = new ConstraintCheckNode(
		ctx.scope,
		expandedSourceNode,
		tableReference,
		RowOp.INSERT,
		undefined, // oldRowDescriptor - not needed for INSERT
		undefined  // newRowDescriptor - not needed for non-returning inserts
	);

	const insertNode = new InsertNode(
		ctx.scope,
		tableReference,
		finalTargetColumns, // Use final target columns (all table columns)
		constraintCheckNode, // Use constraint-checked rows as source
		stmt.onConflict
	);

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

		// Always inject ConstraintCheckNode for INSERT operations (even with RETURNING)
		const constraintCheckNodeWithDescriptor = new ConstraintCheckNode(
			ctx.scope,
			expandedSourceNode,
			tableReference,
			RowOp.INSERT,
			undefined, // oldRowDescriptor - not needed for INSERT
			newRowDescriptor
		);

		// Create a new InsertNode with the row descriptor
		const insertNodeWithDescriptor = new InsertNode(
			ctx.scope,
			tableReference,
			finalTargetColumns, // Use final target columns (all table columns)
			constraintCheckNodeWithDescriptor, // Use constraint-checked rows as source
			stmt.onConflict,
			newRowDescriptor
		);

		return new ReturningNode(ctx.scope, insertNodeWithDescriptor, returningProjections);
	}

	return new SinkNode(ctx.scope, resultNode, 'insert');
}
