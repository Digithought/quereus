import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { InsertNode } from '../nodes/insert-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildSelectStmt } from './select.js';
import { buildWithClause } from './with.js';
import { ValuesNode } from '../nodes/values-node.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type RowDescriptor } from '../nodes/plan-node.js';
import { buildExpression } from './expression.js';
import { checkColumnsAssignable, columnSchemaToDef } from '../type-utils.js';
import type { ColumnDef } from '../../common/datatype.js';
import type { CTEScopeNode } from '../nodes/cte-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode, TableReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOpFlag } from '../../schema/table.js';
import { ReturningNode } from '../nodes/returning-node.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildOldNewRowDescriptors } from '../../util/row-descriptor.js';
import { DmlExecutorNode } from '../nodes/dml-executor-node.js';
import { buildConstraintChecks } from './constraint-builder.js';

/**
 * Creates a uniform row expansion projection that maps any relational source
 * to the target table's column structure, filling in defaults for omitted columns.
 * This ensures INSERT works orthogonally with any relational source.
 */
function createRowExpansionProjection(
	ctx: PlanningContext,
	sourceNode: RelationalPlanNode,
	targetColumns: ColumnDef[],
	tableReference: TableReferenceNode,
	contextScope?: RegisteredScope
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

	// If we have a context scope, we need to also register source columns in it
	// so that defaults can reference them (e.g., DEFAULT base_price + markup)
	if (contextScope) {
		targetColumns.forEach((targetCol, index) => {
			if (index < sourceAttributes.length) {
				const sourceAttr = sourceAttributes[index];
				const colNameLower = targetCol.name.toLowerCase();
				contextScope.registerSymbol(colNameLower, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, sourceAttr.type, sourceAttr.id, index)
				);
			}
		});
	}

	tableSchema.columns.forEach((tableColumn) => {
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
					{ type: 'column', name: sourceAttr.name } satisfies AST.ColumnExpr,
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
			// Use context scope for default evaluation if available
			const defaultCtx = contextScope ? { ...ctx, scope: contextScope } : ctx;
			if (tableColumn.defaultValue !== undefined) {
				// Use default value
				if (typeof tableColumn.defaultValue === 'object' && tableColumn.defaultValue !== null && 'type' in tableColumn.defaultValue) {
					// It's an AST.Expression - build it into a plan node with context scope
					defaultNode = buildExpression(defaultCtx, tableColumn.defaultValue as AST.Expression) as ScalarPlanNode;
				} else {
					// Literal default value
					defaultNode = buildExpression(defaultCtx, { type: 'literal', value: tableColumn.defaultValue }) as ScalarPlanNode;
				}
			} else {
				// No default value - use NULL
				defaultNode = buildExpression(defaultCtx, { type: 'literal', value: null }) as ScalarPlanNode;
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

export function buildInsertStmt(
	ctx: PlanningContext,
	stmt: AST.InsertStmt,
): PlanNode {
	const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, ctx);
	const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

	// Process mutation context assignments if present
	const mutationContextValues = new Map<string, ScalarPlanNode>();
	const contextAttributes: Attribute[] = [];
	let contextScope: RegisteredScope | undefined;

	if (stmt.contextValues && tableReference.tableSchema.mutationContext) {
		// Create context attributes
		tableReference.tableSchema.mutationContext.forEach((contextVar) => {
			contextAttributes.push({
				id: PlanNode.nextAttrId(),
				name: contextVar.name,
				type: {
					typeClass: 'scalar' as const,
					affinity: contextVar.affinity,
					nullable: !contextVar.notNull,
					isReadOnly: true
				},
				sourceRelation: `context.${tableReference.tableSchema.name}`
			});
		});

		// Create a new scope for mutation context
		contextScope = new RegisteredScope(ctx.scope);

		// Register mutation context variables in the scope (before evaluating expressions)
		contextAttributes.forEach((attr, index) => {
			const contextVar = tableReference.tableSchema.mutationContext![index];
			const varNameLower = contextVar.name.toLowerCase();

			// Register both unqualified and qualified names
			contextScope!.subscribeFactory(varNameLower, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, index)
			);
			contextScope!.subscribeFactory(`context.${varNameLower}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, index)
			);
		});

		// Build context value expressions using the context scope
		const contextWithScope = { ...ctx, scope: contextScope };
		stmt.contextValues.forEach((assignment) => {
			const valueExpr = buildExpression(contextWithScope, assignment.value) as ScalarPlanNode;
			mutationContextValues.set(assignment.name, valueExpr);
		});
	}

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
		let parentCtes: Map<string, CTEScopeNode> = new Map();
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

	// ORTHOGONAL ROW EXPANSION: Apply uniform row expansion to map any source to table structure with defaults
	const expandedSourceNode = createRowExpansionProjection(ctx, sourceNode, targetColumns, tableReference, contextScope);

	// Update targetColumns to reflect all table columns since we've expanded the source
	const finalTargetColumns = tableReference.tableSchema.columns.map(col => columnSchemaToDef(col.name, col));

	// Create OLD/NEW attributes for INSERT (OLD = all NULL, NEW = actual values)
	const oldAttributes = tableReference.tableSchema.columns.map((col) => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: {
			typeClass: 'scalar' as const,
			affinity: col.affinity,
			nullable: true, // OLD values are always NULL for INSERT
			isReadOnly: false
		},
		sourceRelation: `OLD.${tableReference.tableSchema.name}`
	}));

	const newAttributes = tableReference.tableSchema.columns.map((col) => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: {
			typeClass: 'scalar' as const,
			affinity: col.affinity,
			nullable: !col.notNull,
			isReadOnly: false
		},
		sourceRelation: `NEW.${tableReference.tableSchema.name}`
	}));

	const { oldRowDescriptor, newRowDescriptor, flatRowDescriptor } = buildOldNewRowDescriptors(oldAttributes, newAttributes);

	// Build context descriptor if we have context attributes
	const contextDescriptor: RowDescriptor = contextAttributes.length > 0 ? [] : undefined as any;
	if (contextDescriptor) {
		contextAttributes.forEach((attr, index) => {
			contextDescriptor[attr.id] = index;
		});
	}

	// Build constraint checks at plan time
	const constraintChecks = buildConstraintChecks(
		ctx,
		tableReference.tableSchema,
		RowOpFlag.INSERT,
		oldAttributes,
		newAttributes,
		flatRowDescriptor,
		contextAttributes
	);

	const insertNode = new InsertNode(
		ctx.scope,
		tableReference,
		finalTargetColumns,
		expandedSourceNode,
		flatRowDescriptor,
		mutationContextValues.size > 0 ? mutationContextValues : undefined,
		contextAttributes.length > 0 ? contextAttributes : undefined,
		contextDescriptor
	);

	const constraintCheckNode = new ConstraintCheckNode(
		ctx.scope,
		insertNode,
		tableReference,
		RowOpFlag.INSERT,
		oldRowDescriptor,
		newRowDescriptor,
		flatRowDescriptor,
		constraintChecks,
		mutationContextValues.size > 0 ? mutationContextValues : undefined,
		contextAttributes.length > 0 ? contextAttributes : undefined,
		contextDescriptor
	);

	// Add DML executor node to perform the actual database insert operations
	const dmlExecutorNode = new DmlExecutorNode(
		ctx.scope,
		constraintCheckNode,
		tableReference,
		'insert',
		stmt.onConflict
	);

	const resultNode: RelationalPlanNode = dmlExecutorNode;

	if (stmt.returning && stmt.returning.length > 0) {
		// Create returning scope with OLD/NEW attribute access
		const returningScope = new RegisteredScope(ctx.scope);

		// Register OLD.* symbols (always NULL for INSERT)
		oldAttributes.forEach((attr, columnIndex) => {
			const tableColumn = tableReference.tableSchema.columns[columnIndex];
			returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		// Register NEW.* symbols and unqualified column names (default to NEW)
		newAttributes.forEach((attr, columnIndex) => {
			const tableColumn = tableReference.tableSchema.columns[columnIndex];

			// NEW.column
			returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// Unqualified column (defaults to NEW)
			returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// Table-qualified form (table.column -> NEW)
			const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
			returningScope.registerSymbol(tblQualified, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		// Build RETURNING projections in the OLD/NEW context
		const returningProjections = stmt.returning.map(rc => {
			// TODO: Support RETURNING *
			if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);

					// Infer alias from column name if not explicitly provided
		let alias = rc.alias;
		if (!alias && rc.expr.type === 'column') {
			// For qualified column references like NEW.id, normalize to lowercase
			if (rc.expr.table) {
				alias = `${rc.expr.table.toLowerCase()}.${rc.expr.name.toLowerCase()}`;
			} else {
				alias = rc.expr.name.toLowerCase();
			}
		}

			// Validate that OLD references are not used in INSERT RETURNING
			validateReturningExpression(rc.expr, 'INSERT');

			return {
				node: buildExpression({ ...ctx, scope: returningScope }, rc.expr) as ScalarPlanNode,
				alias: alias
			};
		});

		return new ReturningNode(ctx.scope, dmlExecutorNode, returningProjections);
	}

	return new SinkNode(ctx.scope, resultNode, 'insert');
}
