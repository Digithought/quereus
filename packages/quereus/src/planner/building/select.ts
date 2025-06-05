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

// Import decomposed functionality
import { buildWithContext, getNonParamAncestor } from './select-context.js';
import { buildCompoundSelect } from './select-compound.js';
import {
	analyzeSelectColumns,
	buildStarProjections,
	isAggregateExpression,
	isWindowExpression
} from './select-projections.js';
import { buildAggregatePhase, buildFinalAggregateProjections } from './select-aggregates.js';
import { buildWindowPhase } from './select-window.js';
import {
	buildFinalProjections,
	applyDistinct,
	applyOrderBy,
	applyLimitOffset
} from './select-modifiers.js';



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

	// TODO: Support multiple FROM sources (joins)
	if (fromTables.length > 1) {
		throw new QuereusError(
			'SELECT with multiple FROM sources (joins) not yet supported.',
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

export function buildFrom(fromClause: AST.FromClause, parentContext: PlanningContext, cteNodes: Map<string, CTEPlanNode> = new Map()): RelationalPlanNode {
  let fromTable: RelationalPlanNode;
  let columnScope: Scope;

	if (fromClause.type === 'table') {
		const tableName = fromClause.table.name.toLowerCase();

		// First check if this is a CTE reference
		const cteNode = cteNodes.get(tableName);
		if (cteNode) {
			// This is a CTE reference
			const cteRefNode = new CTEReferenceNode(parentContext.scope, cteNode, fromClause.alias);
			fromTable = cteRefNode;

			// Column scope for CTE - no parent needed since it only contains column symbols
			const cteScope = new RegisteredScope();
			const attributes = fromTable.getAttributes();
			fromTable.getType().columns.forEach((c, i) => {
				const attr = attributes[i];
				cteScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
			});

			if (fromClause.alias) {
				columnScope = new AliasedScope(cteScope, tableName, fromClause.alias.toLowerCase());
			} else {
				// Even without an explicit alias, we need to support qualified column references using the CTE name
				columnScope = new AliasedScope(cteScope, tableName, tableName);
			}
		} else {
			// Check if this is a view reference
			const schemaName = fromClause.table.schema || parentContext.db.schemaManager.getCurrentSchemaName();
			const viewSchema = parentContext.db.schemaManager.getView(schemaName, fromClause.table.name);

			if (viewSchema) {
				// This is a view reference - expand it to the underlying SELECT statement
				fromTable = buildSelectStmt(parentContext, viewSchema.selectAst, cteNodes) as RelationalPlanNode;

				// Column scope for view - no parent needed since it only contains column symbols
				const viewScope = new RegisteredScope();
				const attributes = fromTable.getAttributes();

				// Use view column names if explicitly defined, otherwise use the SELECT output column names
				const columnNames = viewSchema.columns || fromTable.getType().columns.map(c => c.name);

				columnNames.forEach((columnName, i) => {
					if (i < attributes.length) {
						const attr = attributes[i];
						const columnType = fromTable.getType().columns[i].type; // Use actual column type
						viewScope.registerSymbol(columnName.toLowerCase(), (exp, s) =>
							new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, attr.id, i));
					}
				});

				if (fromClause.alias) {
					columnScope = new AliasedScope(viewScope, fromClause.table.name.toLowerCase(), fromClause.alias.toLowerCase());
				} else {
					// Even without an explicit alias, we need to support qualified column references using the view name
					columnScope = new AliasedScope(viewScope, fromClause.table.name.toLowerCase(), fromClause.table.name.toLowerCase());
				}
			} else {
				// This is a regular table reference
				fromTable = buildTableScan(fromClause, parentContext);

				// Column scope for table - no parent needed since it only contains column symbols
				const tableScope = new RegisteredScope();
				const attributes = fromTable.getAttributes();
				fromTable.getType().columns.forEach((c, i) => {
					const attr = attributes[i];
					tableScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
				});

				if (fromClause.alias) {
					columnScope = new AliasedScope(tableScope, fromClause.table.name.toLowerCase(), fromClause.alias.toLowerCase());
				} else {
					// Even without an explicit alias, we need to support qualified column references using the table name
					columnScope = new AliasedScope(tableScope, fromClause.table.name.toLowerCase(), fromClause.table.name.toLowerCase());
				}
			}
		}

		// Store the column scope for buildSelectStmt
		(fromTable as any).columnScope = columnScope;
	} else if (fromClause.type === 'functionSource') {
		fromTable = buildTableFunctionCall(fromClause, parentContext);

		// Column scope for function - no parent needed since it only contains column symbols
		const functionScope = new RegisteredScope();
		const attributes = fromTable.getAttributes();
		fromTable.getType().columns.forEach((c, i) => {
			const attr = attributes[i];
			functionScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
		});

		if (fromClause.alias) {
			// For table-valued functions, use empty string as parent name since columns are registered without qualifier
			columnScope = new AliasedScope(functionScope, '', fromClause.alias.toLowerCase());
		} else {
			columnScope = functionScope;
		}

		// Store the column scope for buildSelectStmt
		(fromTable as any).columnScope = columnScope;
	} else if (fromClause.type === 'subquerySource') {
		// Build the subquery as a relational plan node
		fromTable = buildSelectStmt(parentContext, fromClause.subquery, cteNodes) as RelationalPlanNode;

		// Column scope for subquery - no parent needed since it only contains column symbols
		const subqueryScope = new RegisteredScope();
		const attributes = fromTable.getAttributes();
		fromTable.getType().columns.forEach((c, i) => {
			const attr = attributes[i];
			subqueryScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
		});

		// Subqueries always have an alias (required by parser)
		columnScope = new AliasedScope(subqueryScope, '', fromClause.alias.toLowerCase());

		// Store the column scope for buildSelectStmt
		(fromTable as any).columnScope = columnScope;
	} else if (fromClause.type === 'join') {
		// Handle JOIN clauses
		return buildJoin(fromClause, parentContext, cteNodes);
	} else {
		// Handle the case where fromClause.type is not recognized
		const exhaustiveCheck: never = fromClause;
		throw new QuereusError(
			`Unsupported FROM clause item type: ${(exhaustiveCheck as any).type}`,
			StatusCode.UNSUPPORTED,
			undefined,
			(exhaustiveCheck as any).loc?.startLine,
			(exhaustiveCheck as any).loc?.startColumn
		);
	}
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
