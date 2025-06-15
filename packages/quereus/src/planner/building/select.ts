import type * as AST from '../../parser/ast.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { PlanningContext } from '../planning-context.js';
import { SingleRowNode } from '../nodes/single-row.js';
import { buildTableScan } from './table.js';
import { AliasedScope } from '../scopes/aliased.js';
import { RegisteredScope } from '../scopes/registered.js';
import type { Scope } from '../scopes/scope.js';
import { MultiScope } from '../scopes/multi.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildExpression } from './expression.js';
import { FilterNode } from '../nodes/filter.js';
import { buildTableFunctionCall } from './table-function.js';
import { CTEReferenceNode } from '../nodes/cte-reference-node.js';
import type { CTEPlanNode } from '../nodes/cte-node.js';
import { JoinNode } from '../nodes/join-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { ValuesNode } from '../nodes/values-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';

// Import decomposed functionality
import { buildWithContext } from './select-context.js';
import { buildCompoundSelect } from './select-compound.js';
import { analyzeSelectColumns, buildStarProjections } from './select-projections.js';
import { buildAggregatePhase, buildFinalAggregateProjections } from './select-aggregates.js';
import { buildWindowPhase } from './select-window.js';
import { buildFinalProjections, applyDistinct, applyOrderBy, applyLimitOffset } from './select-modifiers.js';

import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';

/**
 * Creates an initial logical query plan for a SELECT statement.
 *
 * For this initial version, it only supports simple "SELECT ... FROM one_table" queries,
 * effectively returning a TableScanNode for that table.
 *
 * @param stmt The AST.SelectStmt to plan.
 * @param ctx The parent planning context for this SELECT statement.
 * @param parentCTEs A map of parent CTEs for compound statements.
 * @returns A BatchNode representing the plan for the SELECT statement.
 * @throws {QuereusError} If the FROM clause is missing, empty, or contains more than one source.
 */
export function buildSelectStmt(
  ctx: PlanningContext,
  stmt: AST.SelectStmt,
  parentCTEs: Map<string, CTEPlanNode> = new Map()
): PlanNode {

	// Phase 0: Handle WITH clause if present
	const { contextWithCTEs, cteNodes } = buildWithContext(ctx, stmt, parentCTEs);

	// Handle compound set operations (UNION / INTERSECT / EXCEPT)
	if (stmt.compound) {
		return buildCompoundSelect(stmt, contextWithCTEs, cteNodes,
			(ctx, stmt, parentCTEs) => buildSelectStmt(ctx, stmt, parentCTEs) as RelationalPlanNode);
	}

	// Phase 1: Plan FROM clause and determine local input relations for the current select scope
	const fromTables = !stmt.from || stmt.from.length === 0
		? [SingleRowNode.instance]
		: stmt.from.map(from => buildFrom(from, contextWithCTEs, cteNodes));

	// Multiple FROM sources (from joins) are not supported - maybe never will be
	if (fromTables.length > 1) {
		throw new QuereusError(
			'SELECT with multiple FROM sources (joins) not supported.',
			StatusCode.UNSUPPORTED, undefined, stmt.from![1].loc?.start.line, stmt.from![1].loc?.start.column
		);
	}

	// Phase 2: Create the main scope for this SELECT statement
	const columnScopes = fromTables.map(ft => (ft as any).columnScope || ft.scope).filter(Boolean);
	const selectScope = new MultiScope([...columnScopes, contextWithCTEs.scope]);
	let selectContext: PlanningContext = { ...contextWithCTEs, scope: selectScope };

	let input: RelationalPlanNode = fromTables[0];

	// Plan WHERE clause
	if (stmt.where) {
		const whereExpression = buildExpression(selectContext, stmt.where);
		input = new FilterNode(selectScope, input, whereExpression);
	}

	// Build projections based on the SELECT list
	let projections: Projection[] = [];

	// Analyze SELECT columns
	const {
		projections: columnProjections,
		aggregates,
		windowFunctions,
		hasAggregates,
		hasWindowFunctions
	} = analyzeSelectColumns(stmt.columns, selectContext);

	// Handle SELECT * separately
	for (const column of stmt.columns) {
		if (column.type === 'all') {
			const starProjections = buildStarProjections(column, input, selectScope);
			projections.push(...starProjections);
		}
	}

	// Add non-star projections
	projections.push(...columnProjections);

	// Process aggregates if present
	const aggregateResult = buildAggregatePhase(input, stmt, selectContext, aggregates, hasAggregates, projections);
	input = aggregateResult.output;
	let preAggregateSort = aggregateResult.preAggregateSort;

	// Update context if we have aggregates
	if (aggregateResult.aggregateScope) {
		selectContext = { ...selectContext, scope: aggregateResult.aggregateScope };

		// Build final projections if needed
		if (aggregateResult.needsFinalProjection) {
			const finalProjections = buildFinalAggregateProjections(stmt, selectContext, aggregateResult.aggregateScope);
			input = new ProjectNode(selectScope, input, finalProjections);
		}
	}

	// Handle window functions if present
	input = buildWindowPhase(input, windowFunctions, selectContext, stmt);

	// Handle final projections for non-aggregate cases
	if (!hasAggregates && !hasWindowFunctions) {
		const finalResult = buildFinalProjections(input, projections, selectScope, stmt, selectContext);
		input = finalResult.output;
		selectContext = finalResult.finalContext;
		preAggregateSort = finalResult.preAggregateSort;
	}

	// Apply final modifiers
	input = applyDistinct(input, stmt, selectScope);
	input = applyOrderBy(input, stmt, selectContext, preAggregateSort);
	input = applyLimitOffset(input, stmt, selectContext);

	return input;
}

/**
 * Creates a plan for a VALUES statement.
 *
 * @param ctx The planning context
 * @param stmt The AST.ValuesStmt to plan
 * @returns A ValuesNode representing the VALUES clause
 */
export function buildValuesStmt(
	ctx: PlanningContext,
	stmt: AST.ValuesStmt
): ValuesNode {
	// Build each row of values
	const rows: ScalarPlanNode[][] = stmt.values.map(rowValues =>
		rowValues.map(valueExpr => buildExpression(ctx, valueExpr))
	);

	// Create the VALUES node
	return new ValuesNode(ctx.scope, rows);
}

export function buildFrom(fromClause: AST.FromClause, parentContext: PlanningContext, cteNodes: Map<string, CTEPlanNode> = new Map()): RelationalPlanNode {
	let fromTable: RelationalPlanNode;
	let columnScope: Scope;

	if (fromClause.type === 'table') {
		const tableName = fromClause.table.name.toLowerCase();

		// Check if this is a CTE reference
		if (cteNodes.has(tableName)) {
			const cteNode = cteNodes.get(tableName)!;
			const cteRefNode = new CTEReferenceNode(parentContext.scope, cteNode, fromClause.alias);

			// Create scope for CTE columns
			const cteScope = new RegisteredScope(parentContext.scope);
			const cteAttributes = cteNode.getAttributes();
			cteNode.getType().columns.forEach((c, i) => {
				const attr = cteAttributes[i];
				cteScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
			});

			if (fromClause.alias) {
				columnScope = new AliasedScope(cteScope, tableName, fromClause.alias.toLowerCase());
			} else {
				columnScope = new AliasedScope(cteScope, tableName, tableName);
			}

			fromTable = cteRefNode;
		} else {
			// Check if this is a view
			const schemaName = fromClause.table.schema || parentContext.db.schemaManager.getCurrentSchemaName();
			const viewSchema = parentContext.db.schemaManager.getView(schemaName, fromClause.table.name);

			if (viewSchema) {
				// Build the view's SELECT statement
				fromTable = buildSelectStmt(parentContext, viewSchema.selectAst, cteNodes) as RelationalPlanNode;

				// Create scope for view columns
				const viewScope = new RegisteredScope(parentContext.scope);
				const viewAttributes = fromTable.getAttributes();
				fromTable.getType().columns.forEach((c, i) => {
					const attr = viewAttributes[i];
					viewScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
				});

				if (fromClause.alias) {
					columnScope = new AliasedScope(viewScope, fromClause.table.name.toLowerCase(), fromClause.alias.toLowerCase());
				} else {
					columnScope = new AliasedScope(viewScope, fromClause.table.name.toLowerCase(), fromClause.table.name.toLowerCase());
				}
			} else {
				// Regular table
				fromTable = buildTableScan(fromClause, parentContext);

				// Create scope for table columns
				const tableScope = new RegisteredScope(parentContext.scope);
				const tableAttributes = fromTable.getAttributes();
				fromTable.getType().columns.forEach((c, i) => {
					const attr = tableAttributes[i];
					tableScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
				});

				if (fromClause.alias) {
					columnScope = new AliasedScope(tableScope, fromClause.table.name.toLowerCase(), fromClause.alias.toLowerCase());
				} else {
					columnScope = new AliasedScope(tableScope, fromClause.table.name.toLowerCase(), fromClause.table.name.toLowerCase());
				}
			}
		}

	} else if (fromClause.type === 'functionSource') {
		fromTable = buildTableFunctionCall(fromClause, parentContext);

		// Create scope for function columns
		const functionScope = new RegisteredScope(parentContext.scope);
		const functionAttributes = fromTable.getAttributes();
		fromTable.getType().columns.forEach((c, i) => {
			const attr = functionAttributes[i];
			functionScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
		});

		if (fromClause.alias) {
			// Use the alias as the table name
			columnScope = new AliasedScope(functionScope, '', fromClause.alias.toLowerCase());
		} else {
			// Use the function name as the table name
			columnScope = new AliasedScope(functionScope, '', fromClause.name.name.toLowerCase());
		}

	} else if (fromClause.type === 'subquerySource') {
		// Build the subquery
		if (fromClause.subquery.type === 'select') {
			fromTable = buildSelectStmt(parentContext, fromClause.subquery, cteNodes) as RelationalPlanNode;
		} else if (fromClause.subquery.type === 'values') {
			fromTable = buildValuesStmt(parentContext, fromClause.subquery);
		} else {
			const exhaustiveCheck: never = fromClause.subquery;
			throw new QuereusError(`Unsupported subquery type: ${(exhaustiveCheck as any).type}`, StatusCode.INTERNAL);
		}

		// Create scope for subquery columns
		const subqueryScope = new RegisteredScope(parentContext.scope);
		const subqueryAttributes = fromTable.getAttributes();

		// Use provided column names or infer from subquery
		const columnNames = fromClause.columns || fromTable.getType().columns.map(c => c.name);

		columnNames.forEach((colName, i) => {
			if (i < subqueryAttributes.length) {
				const attr = subqueryAttributes[i];
				const columnType = fromTable.getType().columns[i]?.type || { typeClass: 'scalar', affinity: 'TEXT', nullable: true, isReadOnly: true };
				subqueryScope.registerSymbol(colName.toLowerCase(), (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, attr.id, i));
			}
		});

		columnScope = new AliasedScope(subqueryScope, '', fromClause.alias.toLowerCase());

	} else if (fromClause.type === 'mutatingSubquerySource') {
		// Build the mutating subquery (DML with RETURNING)
		let dmlNode: RelationalPlanNode;

		if (fromClause.stmt.type === 'insert') {
			// Build INSERT without SinkNode wrapper since we need the RETURNING results
			dmlNode = buildInsertStmt(parentContext, fromClause.stmt) as RelationalPlanNode;
		} else if (fromClause.stmt.type === 'update') {
			// Build UPDATE without SinkNode wrapper since we need the RETURNING results
			dmlNode = buildUpdateStmt(parentContext, fromClause.stmt) as RelationalPlanNode;
		} else if (fromClause.stmt.type === 'delete') {
			// Build DELETE without SinkNode wrapper since we need the RETURNING results
			dmlNode = buildDeleteStmt(parentContext, fromClause.stmt) as RelationalPlanNode;
		} else {
			const exhaustiveCheck: never = fromClause.stmt;
			throw new QuereusError(`Unsupported mutating subquery type: ${(exhaustiveCheck as any).type}`, StatusCode.INTERNAL);
		}

		fromTable = dmlNode;

		// Create scope for mutating subquery columns
		const mutatingScope = new RegisteredScope(parentContext.scope);
		const mutatingAttributes = fromTable.getAttributes();

		// Use provided column names or infer from RETURNING clause
		const columnNames = fromClause.columns || fromTable.getType().columns.map(c => c.name);

		columnNames.forEach((colName, i) => {
			if (i < mutatingAttributes.length) {
				const attr = mutatingAttributes[i];
				const columnType = fromTable.getType().columns[i]?.type || { typeClass: 'scalar', affinity: 'TEXT', nullable: true, isReadOnly: false };
				mutatingScope.registerSymbol(colName.toLowerCase(), (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, attr.id, i));
			}
		});

		columnScope = new AliasedScope(mutatingScope, '', fromClause.alias.toLowerCase());

	} else if (fromClause.type === 'join') {
		// Handle JOIN clauses
		return buildJoin(fromClause, parentContext, cteNodes);
	} else {
		// Handle the case where fromClause.type is not recognized
		const exhaustiveCheck: never = fromClause;
		throw new QuereusError(`Unsupported FROM clause type: ${(exhaustiveCheck as any).type}`, StatusCode.INTERNAL);
	}

	// Update the context with the new scope and store columnScope on the node
	const newContext = { ...parentContext, scope: columnScope };
	(fromTable as any).columnScope = columnScope;
	return fromTable;
}

/**
 * Builds a join plan node from an AST join clause
 */
function buildJoin(joinClause: AST.JoinClause, parentContext: PlanningContext, cteNodes: Map<string, CTEPlanNode>): JoinNode {
	// Build left and right sides recursively
	const leftNode = buildFrom(joinClause.left, parentContext, cteNodes);
	const rightNode = buildFrom(joinClause.right, parentContext, cteNodes);

	// Extract column scopes from left and right nodes
	const leftScope = (leftNode as any).columnScope as Scope;
	const rightScope = (rightNode as any).columnScope as Scope;

	// Create a combined scope for the join that includes both left and right columns
	const combinedScope = new MultiScope([leftScope, rightScope]);

	// Create a new planning context with the combined scope for condition evaluation
	const joinContext: PlanningContext = {
		...parentContext,
		scope: combinedScope
	};

	let condition: ScalarPlanNode | undefined;
	let usingColumns: string[] | undefined;

	// Handle ON condition
	if (joinClause.condition) {
		condition = buildExpression(joinContext, joinClause.condition);
	}

	// Handle USING columns
	if (joinClause.columns) {
		usingColumns = joinClause.columns;
		// Convert USING to ON condition: table1.col1 = table2.col1 AND table1.col2 = table2.col2 ...
		// For now, store the column names and let the emitter handle the condition
		// TODO: This could be improved by synthesizing the equality conditions here
	}

	const joinNode = new JoinNode(
		parentContext.scope,
		leftNode,
		rightNode,
		joinClause.joinType,
		condition,
		usingColumns
	);

	// Use the combined scope as the column scope for the join
	// This allows both qualified and unqualified column references to resolve properly
	(joinNode as any).columnScope = combinedScope;

	return joinNode;
}
