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
	input: any,
	selectScope: any
): Projection[] {
	const projections: Projection[] = [];
	const inputColumns = input.getType().columns;
	const inputAttributes = input.getAttributes();

	if (column.table) {
		// Handle qualified SELECT table.*
		const inputTableName = input.source?.tableSchema?.name;
		const tableMatches = column.table.toLowerCase() === inputTableName?.toLowerCase();
		if (!tableMatches) {
			throw new QuereusError(
				`Table '${column.table}' not found in FROM clause for qualified SELECT *`,
				StatusCode.ERROR
			);
		}
	}

	// Add a projection for each column in the input relation
	inputColumns.forEach((columnDef: any, index: number) => {
		const columnExpr: AST.ColumnExpr = {
			type: 'column',
			name: columnDef.name,
		};

		const attr = inputAttributes[index];
		const columnRef = new ColumnReferenceNode(
			selectScope,
			columnExpr,
			columnDef.type,
			attr.id,
			index
		);

		projections.push({
			node: columnRef,
			alias: columnDef.name
		});
	});

	return projections;
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
