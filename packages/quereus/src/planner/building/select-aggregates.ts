import type * as AST from '../../parser/ast.js';
import type { RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import { AggregateNode } from '../nodes/aggregate-node.js';
import { FilterNode } from '../nodes/filter.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Processes GROUP BY, aggregates, and HAVING clauses
 */
export function buildAggregatePhase(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	hasAggregates: boolean,
	projections: Projection[]
): {
	output: RelationalPlanNode;
	aggregateScope?: RegisteredScope;
	needsFinalProjection: boolean;
	preAggregateSort: boolean;
} {
	const hasGroupBy = stmt.groupBy && stmt.groupBy.length > 0;

	if (!hasAggregates && !hasGroupBy) {
		return { output: input, needsFinalProjection: false, preAggregateSort: false };
	}

	// Handle pre-aggregate sorting for ORDER BY without GROUP BY
	const preAggregateSort = Boolean(hasAggregates && !hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0);
	let currentInput = handlePreAggregateSort(input, stmt, selectContext, hasAggregates, !!hasGroupBy);

	// Validate aggregate/non-aggregate mixing
	validateAggregateProjections(projections, hasAggregates, !!hasGroupBy);

	// Build GROUP BY expressions
	const groupByExpressions = stmt.groupBy ?
		stmt.groupBy.map(expr => buildExpression(selectContext, expr, false)) : [];

	// Create AggregateNode
	currentInput = new AggregateNode(selectContext.scope, currentInput, groupByExpressions, aggregates);

	// Create aggregate output scope
	const aggregateOutputScope = createAggregateOutputScope(
		selectContext.scope,
		currentInput,
		groupByExpressions,
		aggregates
	);

	// Handle HAVING clause
	if (stmt.having) {
		currentInput = buildHavingFilter(currentInput, stmt.having, selectContext, aggregateOutputScope, aggregates, groupByExpressions);
	}

	// Determine if final projection is needed
	const needsFinalProjection = checkNeedsFinalProjection(projections);

	return {
		output: currentInput,
		aggregateScope: aggregateOutputScope,
		needsFinalProjection,
		preAggregateSort
	};
}

/**
 * Handles pre-aggregate sorting for special cases
 */
function handlePreAggregateSort(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	hasAggregates: boolean,
	hasGroupBy: boolean
): RelationalPlanNode {
	// Special handling for ORDER BY with aggregates but no GROUP BY
	if (hasAggregates && !hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0) {
		// Apply ORDER BY before aggregation
		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const expression = buildExpression(selectContext, orderByClause.expr);
			return {
				expression,
				direction: orderByClause.direction,
				nulls: orderByClause.nulls
			};
		});

		return new SortNode(selectContext.scope, input, sortKeys);
	}

	return input;
}

/**
 * Validates that aggregate and non-aggregate projections don't mix inappropriately
 */
function validateAggregateProjections(
	projections: Projection[],
	hasAggregates: boolean,
	hasGroupBy: boolean
): void {
	if (projections.length > 0 && hasAggregates && !hasGroupBy) {
		throw new QuereusError(
			'Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY',
			StatusCode.ERROR
		);
	}
}

/**
 * Creates a scope that includes the aggregate output columns
 */
function createAggregateOutputScope(
	parentScope: any,
	aggregateNode: RelationalPlanNode,
	groupByExpressions: ScalarPlanNode[],
	aggregates: { expression: ScalarPlanNode; alias: string }[]
): RegisteredScope {
	const aggregateOutputScope = new RegisteredScope(parentScope);
	const aggregateAttributes = aggregateNode.getAttributes();

	// Register GROUP BY columns
	groupByExpressions.forEach((expr, index) => {
		const attr = aggregateAttributes[index];
		aggregateOutputScope.registerSymbol(attr.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, expr.getType(), attr.id, index));
	});

	// Register aggregate columns by their aliases
	aggregates.forEach((agg, index) => {
		const columnIndex = groupByExpressions.length + index;
		const attr = aggregateAttributes[columnIndex];
		aggregateOutputScope.registerSymbol(agg.alias.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, agg.expression.getType(), attr.id, columnIndex));
	});

	return aggregateOutputScope;
}

/**
 * Builds HAVING filter clause
 */
function buildHavingFilter(
	input: RelationalPlanNode,
	havingClause: AST.Expression,
	selectContext: PlanningContext,
	aggregateOutputScope: RegisteredScope,
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	groupByExpressions: ScalarPlanNode[]
): RelationalPlanNode {
	const aggregateAttributes = input.getAttributes();

	// Build HAVING expression with the aggregate scope
	const havingContext: PlanningContext = {
		...selectContext,
		scope: aggregateOutputScope,
		aggregates: aggregates.map((agg, index) => {
			const columnIndex = groupByExpressions.length + index;
			const attr = aggregateAttributes[columnIndex];
			return {
				expression: agg.expression,
				alias: agg.alias,
				columnIndex,
				attributeId: attr.id
			};
		})
	};

	const havingExpression = buildExpression(havingContext, havingClause, true);

	return new FilterNode(aggregateOutputScope, input, havingExpression);
}

/**
 * Checks if a final projection is needed for complex expressions
 */
function checkNeedsFinalProjection(projections: Projection[]): boolean {
	if (projections.length === 0) {
		return false;
	}

	// Check if any of the projections are complex expressions (not just column refs)
	return projections.some(proj => {
		// If it's not a simple ColumnReferenceNode, we need final projection
		return !(proj.node instanceof ColumnReferenceNode);
	});
}

/**
 * Builds final projections for the complete SELECT list in aggregate context
 */
export function buildFinalAggregateProjections(
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	aggregateOutputScope: RegisteredScope
): Projection[] {
	const finalProjections: Projection[] = [];

	for (const column of stmt.columns) {
		if (column.type === 'column') {
			// Re-build the expression in the context of the aggregate output
			const finalContext: PlanningContext = { ...selectContext, scope: aggregateOutputScope };
			const scalarNode = buildExpression(finalContext, column.expr, true);

			finalProjections.push({
				node: scalarNode,
				alias: column.alias || (column.expr.type === 'column' ? column.expr.name : undefined)
			});
		}
	}

	return finalProjections;
}
