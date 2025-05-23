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
  // This scope sees the parent scope and the relations planned from the FROM clause.
  const selectScope = new MultiScope([ctx.scope, ...fromTables.map(ft => ft.scope)]);
	// Context for planning expressions within this SELECT (e.g., SELECT list, WHERE clause)
	const selectContext: PlanningContext = {...ctx, scope: selectScope};

	let input: RelationalPlanNode = fromTables[0]; // Ensure input is RelationalPlanNode

	// TODO: Plan WHERE clause using currentExpressionPlanningContext, potentially creating a FilterNode

	// TODO: inject a DistinctPlanNode if DISTINCT is present

  //const projections: Projection[] = [];
  // TODO: Populate projections based on stmt.columns using currentExpressionPlanningContext to resolve expressions to ScalarPlanNodes
  // For SELECT *, create ColumnReferenceNodes for each column in filteredInput.getType().columns
  // For other expressions, call a new planExpression(astExpr, currentExpressionPlanningContext) function that returns ScalarPlanNode.
  // Example:
  // stmt.columns.forEach(col => {
		//   if (col.type === 'column' && col.expr) {
  //      const scalarNode = planExpression(col.expr, currentExpressionPlanningContext);
  //      projections.push({ node: scalarNode, alias: col.alias });
  //   } else if (col.type === 'all') { /* handle star */ }
  // });
  //const projectNode = new ProjectNode(currentScope, filteredInput, projections);

	return input;
}

export function buildFrom(fromClause: AST.FromClause, parentContext: PlanningContext): RelationalPlanNode {
  let fromTable: RelationalPlanNode;
  let fromScope: Scope;

	if (fromClause.type === 'table') {
		fromTable = buildTableScan(fromClause, parentContext);

		const tableScope = new RegisteredScope(parentContext.scope);
		fromTable.getType().columns.forEach((c, i) =>
			tableScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, fromTable, i)));
		if (fromClause.alias) {
			const aliasScope = new AliasedScope(tableScope, fromClause.table.name.toLowerCase(), fromClause.alias.toLowerCase());
		} else {
		}
	} else {
		throw new QuereusError(
			`Unsupported FROM clause item type: ${fromClause.type}`,
			StatusCode.UNSUPPORTED, undefined, fromClause.loc?.start.line, fromClause.loc?.start.column
		);
	}
	return fromTable;
}
