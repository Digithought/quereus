import type { RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Projection } from '../nodes/project-node.js';
import { WindowNode, type WindowSpec } from '../nodes/window-node.js';
import { WindowFunctionCallNode } from '../nodes/window-function.js';
import { ArrayIndexNode } from '../nodes/array-index-node.js';
import { ProjectNode } from '../nodes/project-node.js';
import { LiteralNode } from '../nodes/scalar.js';
import { buildExpression } from './expression.js';
import { isWindowExpression } from './select-projections.js';
import type * as AST from '../../parser/ast.js';

/**
 * Processes window functions and creates WindowNode(s) with proper projections
 */
export function buildWindowPhase(
	input: RelationalPlanNode,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[],
	selectContext: PlanningContext,
	stmt: AST.SelectStmt
): RelationalPlanNode {
	if (windowFunctions.length === 0) {
		return input;
	}

	let currentInput = input;

	// Group window functions by their window specification
	const windowGroups = groupWindowFunctionsBySpec(windowFunctions);

	// Create WindowNode for each unique window specification
	for (const [windowSpecKey, functions] of windowGroups) {
		const firstFunc = functions[0];
		const windowSpec: WindowSpec = {
			partitionBy: firstFunc.func.expression.window?.partitionBy || [],
			orderBy: firstFunc.func.expression.window?.orderBy || [],
			frame: firstFunc.func.expression.window?.frame
		};

		// Special case: ROW_NUMBER() without PARTITION BY - use SequencingNode instead
		if (shouldUseSequencingNode(functions, windowSpec)) {
			// TODO: Replace with SequencingNode for optimal performance
			// For now, proceed with WindowNode
		}

		// Create new WindowFunctionCallNode instances with alias information
		const windowFuncsWithAlias = functions.map(({ func, alias }) =>
			new WindowFunctionCallNode(
				func.scope,
				func.expression,
				func.functionName,
				func.isDistinct,
				alias
			)
		);

		// Build expressions for window specification
		const partitionExpressions = windowSpec.partitionBy.map(expr =>
			buildExpression(selectContext, expr, false)
		);

		const orderByExpressions = windowSpec.orderBy.map(orderClause =>
			buildExpression(selectContext, orderClause.expr, false)
		);

		const functionArguments = buildWindowFunctionArguments(windowFuncsWithAlias, selectContext);

		currentInput = new WindowNode(
			selectContext.scope,
			currentInput,
			windowSpec,
			windowFuncsWithAlias,
			partitionExpressions,
			orderByExpressions,
			functionArguments
		);
	}

	// Create projections that select only the requested columns using direct array indexing
	const windowProjections = buildWindowProjections(stmt, currentInput, selectContext, windowFunctions);

	if (windowProjections.length > 0) {
		currentInput = new ProjectNode(selectContext.scope, currentInput, windowProjections);
	}

	return currentInput;
}

/**
 * Groups window functions by their window specification
 */
function groupWindowFunctionsBySpec(
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[]
): Map<string, { func: WindowFunctionCallNode; alias?: string }[]> {
	const windowGroups = new Map<string, { func: WindowFunctionCallNode; alias?: string }[]>();

	for (const { func, alias } of windowFunctions) {
		// Create a key based on the window specification
		const windowSpecKey = JSON.stringify({
			partitionBy: func.expression.window?.partitionBy || [],
			orderBy: func.expression.window?.orderBy || [],
			frame: func.expression.window?.frame
		});

		if (!windowGroups.has(windowSpecKey)) {
			windowGroups.set(windowSpecKey, []);
		}
		windowGroups.get(windowSpecKey)!.push({ func, alias });
	}

	return windowGroups;
}

/**
 * Checks if a sequencing node should be used instead of a window node
 */
function shouldUseSequencingNode(
	functions: { func: WindowFunctionCallNode; alias?: string }[],
	windowSpec: WindowSpec
): boolean {
	return functions.length === 1 &&
		   functions[0].func.functionName.toLowerCase() === 'row_number' &&
		   windowSpec.partitionBy.length === 0;
}

/**
 * Builds function argument expressions for window functions
 */
function buildWindowFunctionArguments(
	windowFuncsWithAlias: WindowFunctionCallNode[],
	selectContext: PlanningContext
): (ScalarPlanNode | null)[] {
	return windowFuncsWithAlias.map(func => {
		if (func.expression.function.args && func.expression.function.args.length > 0) {
			const argExpr = func.expression.function.args[0];
			return buildExpression(selectContext, argExpr, false);
		}
		// Special case for COUNT(*) - it has no args but still needs a placeholder
		if (func.functionName.toLowerCase() === 'count' &&
			func.expression.function.args.length === 0) {
			// Create a literal 1 as the argument for COUNT(*) - it counts rows, not specific values
			return new LiteralNode(selectContext.scope, { type: 'literal', value: 1 });
		}
		return null;
	});
}

/**
 * Builds projections for window function output columns
 */
function buildWindowProjections(
	stmt: AST.SelectStmt,
	windowNode: RelationalPlanNode,
	selectContext: PlanningContext,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[]
): Projection[] {
	const windowProjections: Projection[] = [];
	const windowType = windowNode.getType();
	const sourceColumnCount = windowType.columns.length - windowFunctions.length;

	for (const column of stmt.columns) {
		if (column.type === 'column') {
			if (isWindowExpression(buildExpression(selectContext, column.expr, true))) {
				// For window functions, use ArrayIndexNode to access the value by direct index
				const windowColumnIndex = findWindowFunctionIndex(
					column,
					selectContext,
					windowFunctions,
					sourceColumnCount
				);

				if (windowColumnIndex >= 0) {
					const windowColumnType = windowType.columns[windowColumnIndex].type;

					const arrayIndexNode = new ArrayIndexNode(
						selectContext.scope,
						windowColumnIndex,
						windowColumnType
					);

					windowProjections.push({
						node: arrayIndexNode,
						alias: column.alias
					});
				}
			} else {
				// For regular columns, use ArrayIndexNode to access by index
				const sourceColIndex = findSourceColumnIndex(column, windowType, sourceColumnCount);

				if (sourceColIndex >= 0) {
					const arrayIndexNode = new ArrayIndexNode(
						selectContext.scope,
						sourceColIndex,
						windowType.columns[sourceColIndex].type
					);

					const alias = column.alias || (column.expr.type === 'column' ? column.expr.name : undefined);

					windowProjections.push({
						node: arrayIndexNode,
						alias: alias
					});
				}
			}
		}
	}

	return windowProjections;
}

/**
 * Finds the index of a window function in the window output
 */
function findWindowFunctionIndex(
	column: AST.ResultColumnExpr,
	selectContext: PlanningContext,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[],
	sourceColumnCount: number
): number {
	const originalExpr = buildExpression(selectContext, column.expr, true);

	const matchingWindowFuncIndex = windowFunctions.findIndex(({ func }) => {
		// Match based on function name, parameters, and window specification
		if (!(originalExpr instanceof WindowFunctionCallNode) ||
			func.functionName.toLowerCase() !== originalExpr.functionName.toLowerCase()) {
			return false;
		}

		// Also compare window specifications to distinguish between functions with same name
		const originalWindow = originalExpr.expression.window;
		const funcWindow = func.expression.window;

		return compareWindowSpecs(originalWindow, funcWindow);
	});

	return matchingWindowFuncIndex >= 0 ? sourceColumnCount + matchingWindowFuncIndex : -1;
}

/**
 * Finds the index of a source column in the window output
 */
function findSourceColumnIndex(
	column: AST.ResultColumnExpr,
	windowType: any,
	sourceColumnCount: number
): number {
	return windowType.columns.findIndex((col: any, index: number) => {
		if (index >= sourceColumnCount) return false; // Skip window function columns
		if (column.expr.type === 'column') {
			return col.name.toLowerCase() === column.expr.name.toLowerCase();
		}
		return false;
	});
}

/**
 * Compares two window specifications for equality
 */
function compareWindowSpecs(originalWindow: any, funcWindow: any): boolean {
	// Compare partition expressions
	const originalPartition = JSON.stringify(originalWindow?.partitionBy || []);
	const funcPartition = JSON.stringify(funcWindow?.partitionBy || []);

	// Compare order expressions
	const originalOrder = JSON.stringify(originalWindow?.orderBy || []);
	const funcOrder = JSON.stringify(funcWindow?.orderBy || []);

	// Compare frame specifications
	const originalFrame = JSON.stringify(originalWindow?.frame || null);
	const funcFrame = JSON.stringify(funcWindow?.frame || null);

	return originalPartition === funcPartition &&
		   originalOrder === funcOrder &&
		   originalFrame === funcFrame;
}
