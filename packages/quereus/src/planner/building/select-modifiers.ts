import type * as AST from '../../parser/ast.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Projection } from '../nodes/project-node.js';
import { DistinctNode } from '../nodes/distinct-node.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { LimitOffsetNode } from '../nodes/limit-offset.js';
import { LiteralNode } from '../nodes/scalar.js';
import { ProjectNode } from '../nodes/project-node.js';
import { MultiScope } from '../scopes/multi.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';

/**
 * Builds final projections for non-aggregate cases
 */
export function buildFinalProjections(
	input: RelationalPlanNode,
	projections: Projection[],
	selectScope: any,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	preserveInputColumns: boolean = true
): {
	output: RelationalPlanNode;
	finalContext: PlanningContext;
	projectionScope?: RegisteredScope;
	preAggregateSort: boolean;
} {
	if (projections.length === 0) {
		return { output: input, finalContext: selectContext, preAggregateSort: false };
	}

	// Check if ORDER BY should be applied before projection (using input scope only)
	const needsPreProjectionSort = shouldApplyOrderByBeforeProjection(stmt, projections);
	let preAggregateSort = false;

	let currentInput = input;

	// Apply ORDER BY before projection if needed (compile expressions against input scope)
	if (needsPreProjectionSort && stmt.orderBy && stmt.orderBy.length > 0) {
		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const expression = buildExpression(selectContext, orderByClause.expr);
			return {
				expression,
				direction: orderByClause.direction,
				nulls: orderByClause.nulls
			};
		});
		currentInput = new SortNode(selectScope, currentInput, sortKeys);
		preAggregateSort = true;
	}

	// Create the ProjectNode only after all expressions are compiled against input scope
	currentInput = new ProjectNode(selectScope, currentInput, projections, undefined, undefined, preserveInputColumns);

	// Create projection output scope but DON'T merge it into finalContext yet
	// Let the caller decide when to make these output attributes visible
	const projectionOutputScope = createProjectionOutputScope(currentInput);

	return {
		output: currentInput,
		finalContext: selectContext, // Keep unchanged - no premature scope pollution
		projectionScope: projectionOutputScope,
		preAggregateSort
	};
}

/**
 * Applies DISTINCT modifier if present
 */
export function applyDistinct(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectScope: any
): RelationalPlanNode {
	if (stmt.distinct) {
		return new DistinctNode(selectScope, input);
	}
	return input;
}

/**
 * Applies ORDER BY clause if not already applied
 */
export function applyOrderBy(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	preAggregateSort: boolean,
	projectionScope?: RegisteredScope
): RelationalPlanNode {
	if (stmt.orderBy && stmt.orderBy.length > 0 && !preAggregateSort) {
		// Merge projection scope if available so ORDER BY can reference output column aliases
		let orderByContext = selectContext;
		if (projectionScope) {
			const combinedScope = new MultiScope([projectionScope, selectContext.scope]);
			orderByContext = { ...selectContext, scope: combinedScope };
		}

		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const expression = buildExpression(orderByContext, orderByClause.expr);
			return {
				expression,
				direction: orderByClause.direction,
				nulls: orderByClause.nulls
			};
		});

		return new SortNode(orderByContext.scope, input, sortKeys);
	}
	return input;
}

/**
 * Applies LIMIT and OFFSET clauses
 */
export function applyLimitOffset(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	projectionScope?: RegisteredScope
): RelationalPlanNode {
	if (stmt.limit || stmt.offset) {
		// Merge projection scope if available so LIMIT/OFFSET can reference output column aliases
		let limitContext = selectContext;
		if (projectionScope) {
			const combinedScope = new MultiScope([projectionScope, selectContext.scope]);
			limitContext = { ...selectContext, scope: combinedScope };
		}

		const literalNull = new LiteralNode(limitContext.scope, { type: 'literal', value: null });
		const limitExpression = stmt.limit ? buildExpression(limitContext, stmt.limit) : literalNull;
		const offsetExpression = stmt.offset ? buildExpression(limitContext, stmt.offset) : literalNull;
		return new LimitOffsetNode(limitContext.scope, input, limitExpression, offsetExpression);
	}
	return input;
}

/**
 * Determines if ORDER BY should be applied before projection
 */
function shouldApplyOrderByBeforeProjection(
	stmt: AST.SelectStmt,
	projections: Projection[]
): boolean {
	if (!stmt.orderBy || stmt.orderBy.length === 0) {
		return false;
	}

	// Check if any ORDER BY column is not in the projection aliases
	for (const orderByClause of stmt.orderBy) {
		if (orderByClause.expr.type === 'column') {
			const orderColumn = orderByClause.expr.name.toLowerCase();
			// Check if this column is in the projection aliases
			const isInProjection = projections.some(proj =>
				(proj.alias?.toLowerCase() === orderColumn) ||
				(proj.node instanceof ColumnReferenceNode && proj.node.expression.name.toLowerCase() === orderColumn)
			);
			if (!isInProjection) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Creates a scope for projection output columns
 */
function createProjectionOutputScope(projectionNode: RelationalPlanNode): RegisteredScope {
	const projectionOutputScope = new RegisteredScope();
	const projectionAttributes = projectionNode.getAttributes();

	projectionNode.getType().columns.forEach((col, index) => {
		const attr = projectionAttributes[index];
		projectionOutputScope.registerSymbol(col.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, index));
	});

	return projectionOutputScope;
}
