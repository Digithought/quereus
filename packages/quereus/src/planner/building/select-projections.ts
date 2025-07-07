import type * as AST from '../../parser/ast.js';
import { type ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Projection } from '../nodes/project-node.js';
import { buildExpression } from './expression.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { expressionToString } from '../../util/ast-stringify.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { AggregateFunctionCallNode } from '../nodes/aggregate-function.js';
import { WindowFunctionCallNode } from '../nodes/window-function.js';
import { type RelationalPlanNode } from '../nodes/plan-node.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Checks if an expression contains aggregate functions
 */
export function isAggregateExpression(node: ScalarPlanNode): boolean {
	if (node instanceof AggregateFunctionCallNode) {
		return true;
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		// Check if child is a scalar node and recursively check it
		if ('expression' in child && isAggregateExpression(child as ScalarPlanNode)) {
			return true;
		}
	}

	return false;
}

/**
 * Checks if an expression contains window functions
 */
export function isWindowExpression(node: ScalarPlanNode): boolean {
	if (node instanceof WindowFunctionCallNode) {
		return true;
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		// Check if child is a scalar node and recursively check it
		if ('expression' in child && isWindowExpression(child as ScalarPlanNode)) {
			return true;
		}
	}

	return false;
}

/**
 * Builds projections for SELECT * or table.*
 */
export function buildStarProjections(
	column: { type: 'all'; table?: string },
	source: RelationalPlanNode,
	selectScope: Scope
): Projection[] {
	const allAttributes = source.getAttributes();

	// Filter by relation name if qualified (e.g., SELECT t1.*)
	const matchingAttributes = column.table
		? allAttributes.filter(attr =>
			attr.relationName && attr.relationName.toLowerCase() === column.table!.toLowerCase()
		)
		: allAttributes;

	if (column.table && matchingAttributes.length === 0) {
		throw new QuereusError(
			`Table '${column.table}' not found in FROM clause for qualified SELECT *`,
			StatusCode.ERROR
		);
	}

	// Convert to projections
	return matchingAttributes.map((attr, index) => {
		const columnExpr: AST.ColumnExpr = {
			type: 'column',
			name: attr.name,
		};

		const columnRef = new ColumnReferenceNode(
			selectScope,
			columnExpr,
			attr.type,
			attr.id,
			index
		);

		return {
			node: columnRef,
			alias: attr.name
		};
	});
}

/**
 * Analyzes SELECT columns and categorizes them into different types
 */
export function analyzeSelectColumns(
	columns: AST.ResultColumn[],
	selectContext: PlanningContext
): {
	projections: Projection[];
	aggregates: { expression: ScalarPlanNode; alias: string }[];
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[];
	hasAggregates: boolean;
	hasWindowFunctions: boolean;
} {
	const projections: Projection[] = [];
	const aggregates: { expression: ScalarPlanNode; alias: string }[] = [];
	const windowFunctions: { func: WindowFunctionCallNode; alias?: string }[] = [];
	let hasAggregates = false;
	let hasWindowFunctions = false;

	for (const column of columns) {
		if (column.type === 'all') {
			// Handle SELECT * - will be processed separately
			continue;
		} else if (column.type === 'column') {
			const scalarNode = buildExpression(selectContext, column.expr, true);

			if (isWindowExpression(scalarNode)) {
				hasWindowFunctions = true;
				collectWindowFunctions(scalarNode, column.alias, windowFunctions);
				projections.push({
					node: scalarNode,
					alias: column.alias
				});
			} else if (isAggregateExpression(scalarNode)) {
				hasAggregates = true;
				aggregates.push({
					expression: scalarNode,
					alias: column.alias || expressionToString(column.expr)
				});
			} else {
				projections.push({
					node: scalarNode,
					alias: column.alias
				});
			}
		}
	}

	return {
		projections,
		aggregates,
		windowFunctions,
		hasAggregates,
		hasWindowFunctions
	};
}

/**
 * Collects all window functions from an expression tree, along with their aliases
 */
function collectWindowFunctions(
	node: ScalarPlanNode,
	alias?: string,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[] = []
): { func: WindowFunctionCallNode; alias?: string }[] {
	if (node instanceof WindowFunctionCallNode) {
		windowFunctions.push({ func: node, alias });
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		if ('expression' in child) {
			collectWindowFunctions(child as ScalarPlanNode, undefined, windowFunctions);
		}
	}

	return windowFunctions;
}
