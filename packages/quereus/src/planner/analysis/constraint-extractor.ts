/**
 * Constraint extraction utilities for predicate analysis and VTab.xBestIndex
 * Converts scalar expressions into constraints that can be pushed down to virtual tables
 */

import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';
import type { SqlValue } from '../../common/types.js';

/**
 * Constraint operators that can be pushed down to virtual tables
 */
export type ConstraintOp = '=' | '>' | '>=' | '<' | '<=' | 'MATCH' | 'LIKE' | 'GLOB' | 'IS NULL' | 'IS NOT NULL';

/**
 * A constraint extracted from a predicate expression
 */
export interface PredicateConstraint {
	/** Index of the column in the table schema */
	columnIndex: number;
	/** Attribute ID of the column reference */
	attributeId: number;
	/** Constraint operator */
	op: ConstraintOp;
	/** Constant value for the constraint (if applicable) */
	value?: SqlValue;
	/** Whether this constraint can be used by the virtual table */
	usable: boolean;
	/** Original expression node for debugging */
	sourceExpression: ScalarPlanNode;
}

/**
 * Result of constraint extraction
 */
export interface ConstraintExtractionResult {
	/** Extracted constraints */
	constraints: PredicateConstraint[];
	/** Residual predicate that couldn't be converted to constraints */
	residualPredicate?: ScalarPlanNode;
}

/**
 * Extract constraints from a scalar predicate expression
 * Currently handles simple binary comparisons and basic boolean logic
 */
export function extractConstraints(
	predicate: ScalarPlanNode,
	columnAttributeToIndex?: Map<number, number>
): ConstraintExtractionResult {
	const constraints: PredicateConstraint[] = [];
	const residualExpressions: ScalarPlanNode[] = [];

	// Start extraction process
	extractFromExpression(predicate, constraints, residualExpressions, columnAttributeToIndex);

	// Build residual predicate from unmatched expressions
	let residualPredicate: ScalarPlanNode | undefined;
	if (residualExpressions.length === 1) {
		residualPredicate = residualExpressions[0];
	} else if (residualExpressions.length > 1) {
		// For now, combine with AND - more sophisticated logic can be added later
		residualPredicate = combineWithAnd(residualExpressions);
	}

	return {
		constraints,
		residualPredicate
	};
}

/**
 * Recursively extract constraints from an expression
 */
function extractFromExpression(
	expr: ScalarPlanNode,
	constraints: PredicateConstraint[],
	residual: ScalarPlanNode[],
	columnAttributeToIndex?: Map<number, number>
): void {
	// Handle AND expressions - recurse on both sides
	if (isAndExpression(expr)) {
		const children = getBinaryExpressionChildren(expr);
		if (children) {
			extractFromExpression(children.left, constraints, residual, columnAttributeToIndex);
			extractFromExpression(children.right, constraints, residual, columnAttributeToIndex);
			return;
		}
	}

	// Try to extract constraint from binary comparison
	const constraint = extractBinaryConstraint(expr, columnAttributeToIndex);
	if (constraint) {
		constraints.push(constraint);
	} else {
		// Cannot convert to constraint - add to residual
		residual.push(expr);
	}
}

/**
 * Extract constraint from binary comparison expression
 */
function extractBinaryConstraint(
	expr: ScalarPlanNode,
	columnAttributeToIndex?: Map<number, number>
): PredicateConstraint | null {
	const binaryInfo = getBinaryComparisonInfo(expr);
	if (!binaryInfo) {
		return null;
	}

	const { left, right, op } = binaryInfo;

	// Try column-constant pattern (column op constant)
	let columnRef: ColumnReferenceNode | null = null;
	let constant: SqlValue | undefined;
	let constraintOp = op;

	if (isColumnReference(left) && isLiteralConstant(right)) {
		columnRef = left as ColumnReferenceNode;
		constant = getLiteralValue(right);
	} else if (isLiteralConstant(left) && isColumnReference(right)) {
		// Reverse pattern (constant op column) - flip operator
		columnRef = right as ColumnReferenceNode;
		constant = getLiteralValue(left);
		constraintOp = flipOperator(op);
	}

	if (!columnRef) {
		return null;
	}

	// Map attribute ID to column index if mapping provided
	let columnIndex = -1;
	if (columnAttributeToIndex) {
		const mappedIndex = columnAttributeToIndex.get(columnRef.attributeId);
		if (mappedIndex !== undefined) {
			columnIndex = mappedIndex;
		}
	}

	return {
		columnIndex,
		attributeId: columnRef.attributeId,
		op: constraintOp,
		value: constant,
		usable: columnIndex >= 0, // Only usable if we can map to column index
		sourceExpression: expr
	};
}

/**
 * Get information about binary comparison expressions
 */
function getBinaryComparisonInfo(expr: ScalarPlanNode): {
	left: ScalarPlanNode;
	right: ScalarPlanNode;
	op: ConstraintOp;
} | null {
	// This is a simplified version - real implementation would need to handle
	// the actual binary expression node structure
	if (expr.nodeType === PlanNodeType.BinaryOp) {
		// Extract from actual binary expression node
		// This would need to be implemented based on the actual BinaryOpNode structure
		// For now, return null as placeholder
		return null;
	}
	return null;
}

/**
 * Check if expression is an AND operation
 */
function isAndExpression(expr: ScalarPlanNode): boolean {
	// Simplified check - would need actual implementation
	return expr.nodeType === PlanNodeType.BinaryOp;
}

/**
 * Get children of binary expression
 */
function getBinaryExpressionChildren(_expr: ScalarPlanNode): {
	left: ScalarPlanNode;
	right: ScalarPlanNode;
} | null {
	// Simplified - would need actual implementation
	return null;
}

/**
 * Check if node is a column reference
 */
function isColumnReference(node: ScalarPlanNode): boolean {
	return node.nodeType === PlanNodeType.ColumnReference;
}

/**
 * Check if node is a literal constant
 */
function isLiteralConstant(node: ScalarPlanNode): boolean {
	return node.nodeType === PlanNodeType.Literal;
}

/**
 * Get literal value from literal node
 */
function getLiteralValue(_node: ScalarPlanNode): SqlValue {
	// Simplified - would need actual implementation
	return null;
}

/**
 * Flip comparison operator for reversed operand order
 */
function flipOperator(op: ConstraintOp): ConstraintOp {
	switch (op) {
		case '<': return '>';
		case '<=': return '>=';
		case '>': return '<';
		case '>=': return '<=';
		case '=': return '=';
		default: return op;
	}
}

/**
 * Combine multiple expressions with AND logic
 */
function combineWithAnd(expressions: ScalarPlanNode[]): ScalarPlanNode {
	// This would need to create an actual AND expression node
	// For now, return the first expression as placeholder
	return expressions[0];
}

/**
 * Create a residual filter predicate from constraints that weren't handled
 * This allows creating a filter function that can be applied at runtime
 */
export function createResidualFilter(
	originalPredicate: ScalarPlanNode,
	handledConstraints: PredicateConstraint[]
): ((row: any) => boolean) | undefined {
	// If all constraints were handled, no residual filter needed
	if (handledConstraints.length === 0) {
		// Return a simple function that evaluates the original predicate
		// This is a placeholder - real implementation would need to compile the predicate
		return (_row: any) => true;
	}

	// For now, return undefined to indicate no residual filter
	// Real implementation would create a runtime-evaluable filter function
	return undefined;
}

/**
 * Utility to map table schema columns to attribute IDs
 * Used when extracting constraints for specific tables
 */
export function createColumnMapping(
	tableColumns: Array<{ name: string }>,
	nodeAttributes: Array<{ id: number; name: string }>
): Map<number, number> {
	const mapping = new Map<number, number>();

	// Simple name-based mapping
	for (const attr of nodeAttributes) {
		const columnIndex = tableColumns.findIndex(col => col.name === attr.name);
		if (columnIndex >= 0) {
			mapping.set(attr.id, columnIndex);
		}
	}

	return mapping;
}
