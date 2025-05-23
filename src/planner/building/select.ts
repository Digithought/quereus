import type * as AST from '../../parser/ast.js';
import type { PlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { PlanningContext } from '../planning-context.js';
import { SingleRowNode } from '../nodes/single-row.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildTableScan } from './table.js';
import { AliasedScope } from '../scopes/aliased.js';
import { RegisteredScope } from '../scopes/registered.js';
import type { Scope } from '../scopes/scope.js';
import { MultiScope } from '../scopes/multi.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildExpression } from './expression.js';

/**
 * Creates an initial logical query plan for a SELECT statement.
 *
 * For this initial version, it only supports simple "SELECT ... FROM one_table" queries,
 * effectively returning a TableScanNode for that table.
 *
 * @param stmt The AST.SelectStmt to plan.
 * @param ctx The parent planning context for this SELECT statement.
 * @returns A BatchNode representing the plan for the SELECT statement.
 * @throws {QuereusError} If the FROM clause is missing, empty, or contains more than one source.
 */
export function buildSelectStmt(
  ctx: PlanningContext,
  stmt: AST.SelectStmt,
): PlanNode {

  // Phase 1: Plan FROM clause and determine local input relations for the current select scope
  const fromTables = !stmt.from || stmt.from.length === 0
		? [SingleRowNode.instance]
		: stmt.from.map(from => buildFrom(from, ctx));

	// TODO: Support multiple FROM sources (joins)
	if (fromTables.length > 1) {
		throw new QuereusError(
			'SELECT with multiple FROM sources (joins) not yet supported.',
			StatusCode.UNSUPPORTED, undefined, stmt.from![1].loc?.start.line, stmt.from![1].loc?.start.column
		);
	}

	// Phase 2: Create the main scope for this SELECT statement.
  // This scope sees the parent scope and the column scopes from the FROM clause.
  const columnScopes = fromTables.map(ft => (ft as any).columnScope || ft.scope).filter(Boolean);
  const selectScope = new MultiScope([ctx.scope, ...columnScopes]);
	// Context for planning expressions within this SELECT (e.g., SELECT list, WHERE clause)
	const selectContext: PlanningContext = {...ctx, scope: selectScope};

	let input: RelationalPlanNode = fromTables[0]; // Ensure input is RelationalPlanNode

	// TODO: Plan WHERE clause using selectContext, potentially creating a FilterNode

	// TODO: inject a DistinctPlanNode if DISTINCT is present

	// Build projections based on the SELECT list
	const projections: Projection[] = [];

	for (const column of stmt.columns) {
		if (column.type === 'all') {
			// Handle SELECT * or table.*
			const inputColumns = input.getType().columns;

			if (column.table) {
				// Handle qualified SELECT table.*
				// For now, we'll assume the table qualifier matches our single input table
				// TODO: Handle qualified star with multiple tables/joins
				const inputTableName = (input as any).source?.tableSchema?.name;
				const tableMatches = column.table.toLowerCase() === inputTableName?.toLowerCase();
				if (!tableMatches) {
					throw new QuereusError(
						`Table '${column.table}' not found in FROM clause for qualified SELECT *`,
						StatusCode.ERROR
					);
				}
			}

			// Add a projection for each column in the input relation
			inputColumns.forEach((columnDef, index) => {
				// Create a ColumnReferenceNode for this column
				const columnExpr: AST.ColumnExpr = {
					type: 'column',
					name: columnDef.name,
					// Don't set table qualifier for SELECT * projections to avoid confusion
				};

				const columnRef = new ColumnReferenceNode(
					selectScope,
					columnExpr,
					columnDef.type,
					input,
					index
				);

				projections.push({
					node: columnRef,
					alias: columnDef.name // Use the original column name as alias
				});
			});
		} else if (column.type === 'column') {
			// Handle specific expressions
			const scalarNode = buildExpression(selectContext, column.expr);
			projections.push({
				node: scalarNode,
				alias: column.alias // Use the specified alias, if any
			});
		}
	}

	// Create ProjectNode if we have projections, otherwise return input as-is
	if (projections.length > 0) {
		input = new ProjectNode(selectScope, input, projections);
	}

	return input;
}

export function buildFrom(fromClause: AST.FromClause, parentContext: PlanningContext): RelationalPlanNode {
  let fromTable: RelationalPlanNode;
  let columnScope: Scope;

	if (fromClause.type === 'table') {
		fromTable = buildTableScan(fromClause, parentContext);

		const tableScope = new RegisteredScope(parentContext.scope);
		fromTable.getType().columns.forEach((c, i) =>
			tableScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, fromTable, i)));

		if (fromClause.alias) {
			columnScope = new AliasedScope(tableScope, fromClause.table.name.toLowerCase(), fromClause.alias.toLowerCase());
		} else {
			columnScope = tableScope;
		}

		// For now, we'll store the column scope in a property that buildSelectStmt can use
		// TODO: This is a temporary solution; we might need a better design
		(fromTable as any).columnScope = columnScope;
	} else {
		throw new QuereusError(
			`Unsupported FROM clause item type: ${fromClause.type}`,
			StatusCode.UNSUPPORTED, undefined, fromClause.loc?.start.line, fromClause.loc?.start.column
		);
	}
	return fromTable;
}
