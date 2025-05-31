import type { ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { expressionToString } from './ast-stringify.js';
import type { ScalarType } from '../common/datatype.js';
import { SqlDataType } from '../common/types.js';

/**
 * Convert a ScalarPlanNode to its string representation for use in plan descriptions.
 */
export function formatExpression(node: ScalarPlanNode): string {
	return expressionToString(node.expression);
}

/**
 * Convert multiple ScalarPlanNodes to a comma-separated string.
 */
export function formatExpressionList(nodes: readonly ScalarPlanNode[]): string {
	return nodes.map(formatExpression).join(', ');
}

/**
 * Format a scalar type to a simple string representation.
 */
export function formatScalarType(type: ScalarType): string {
	if (type.datatype !== undefined) {
		return SqlDataType[type.datatype];
	}
	return SqlDataType[type.affinity];
}

/**
 * Format projection for display (expression with optional alias).
 */
export function formatProjection(expr: ScalarPlanNode, alias?: string): string {
	const exprStr = formatExpression(expr);
	return alias && alias !== exprStr ? `${exprStr} AS ${alias}` : exprStr;
}

/**
 * Format sort key for display.
 */
export function formatSortKey(
	expr: ScalarPlanNode,
	direction: 'asc' | 'desc',
	nulls?: 'first' | 'last'
): string {
	const parts = [formatExpression(expr), direction.toUpperCase()];
	if (nulls) {
		parts.push(`NULLS ${nulls.toUpperCase()}`);
	}
	return parts.join(' ');
}
