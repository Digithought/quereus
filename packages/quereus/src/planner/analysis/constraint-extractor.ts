/**
 * Constraint extraction utilities for predicate analysis and pushdown optimization
 * Converts scalar expressions into constraints that can be pushed down to virtual tables
 */

import type { ScalarPlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';
import type { BinaryOpNode, LiteralNode } from '../nodes/scalar.js';
import type { Row, SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type * as AST from '../../parser/ast.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import { getSyncLiteral } from '../../parser/utils.js';
import type { ConstraintOp, PredicateConstraint as VtabPredicateConstraint } from '../../vtab/best-access-plan.js';

const log = createLogger('planner:analysis:constraint-extractor');

// ConstraintOp is imported from vtab/best-access-plan.ts

/**
 * A constraint extracted from a predicate expression
 * Extends the vtab PredicateConstraint with additional metadata for the planner
 */
export interface PredicateConstraint extends VtabPredicateConstraint {
	/** Attribute ID of the column reference */
	attributeId: number;
	/** Original expression node for debugging */
	sourceExpression: ScalarPlanNode;
	/** Target table relation (for multi-table predicates) */
	targetRelation?: string;
}

/**
 * Result of constraint extraction
 */
export interface ConstraintExtractionResult {
	/** Extracted constraints grouped by target table relation */
	constraintsByTable: Map<string, PredicateConstraint[]>;
	/** Residual predicate that couldn't be converted to constraints */
	residualPredicate?: ScalarPlanNode;
	/** All constraints in a flat list */
	allConstraints: PredicateConstraint[];
}

/**
 * Table information for constraint mapping
 */
export interface TableInfo {
	relationName: string;
	attributes: Array<{ id: number; name: string }>;
	columnIndexMap: Map<number, number>; // attributeId -> columnIndex
}

/**
 * Extract constraints from a scalar predicate expression
 * Handles binary comparisons, boolean logic (AND/OR), and complex expressions
 */
export function extractConstraints(
	predicate: ScalarPlanNode,
	tableInfos: TableInfo[] = []
): ConstraintExtractionResult {
	const constraintsByTable = new Map<string, PredicateConstraint[]>();
	const allConstraints: PredicateConstraint[] = [];
	const residualExpressions: ScalarPlanNode[] = [];

	log('Extracting constraints from predicate: %s', predicate.toString());

	// Build attribute-to-table mapping for quick lookups
	const tableByAttribute = new Map<number, TableInfo>();
	for (const tableInfo of tableInfos) {
		for (const attr of tableInfo.attributes) {
			tableByAttribute.set(attr.id, tableInfo);
		}
	}

	// Start extraction process
	extractFromExpression(predicate, allConstraints, residualExpressions, tableByAttribute);

	// Group constraints by table
	for (const constraint of allConstraints) {
		if (constraint.targetRelation) {
			if (!constraintsByTable.has(constraint.targetRelation)) {
				constraintsByTable.set(constraint.targetRelation, []);
			}
			constraintsByTable.get(constraint.targetRelation)!.push(constraint);
		}
	}

	// Build residual predicate from unmatched expressions
	let residualPredicate: ScalarPlanNode | undefined;
	if (residualExpressions.length === 1) {
		residualPredicate = residualExpressions[0];
	} else if (residualExpressions.length > 1) {
		// Combine with AND - this would need actual AND node construction
		residualPredicate = residualExpressions[0]; // Simplified for now
		log('Multiple residual expressions found, using first one as simplified residual');
	}

	log('Extracted %d constraints across %d tables, %d residual expressions',
		allConstraints.length, constraintsByTable.size, residualExpressions.length);

	return {
		constraintsByTable,
		residualPredicate,
		allConstraints
	};
}

/**
 * Recursively extract constraints from an expression
 */
function extractFromExpression(
	expr: ScalarPlanNode,
	constraints: PredicateConstraint[],
	residual: ScalarPlanNode[],
	attributeToTableMap: Map<number, TableInfo>
): void {
	// Handle AND expressions - recurse on both sides
	if (isAndExpression(expr)) {
		const binaryOp = expr as BinaryOpNode;
		extractFromExpression(binaryOp.left, constraints, residual, attributeToTableMap);
		extractFromExpression(binaryOp.right, constraints, residual, attributeToTableMap);
		return;
	}

	// Handle OR expressions - for now, treat as residual (could be enhanced later)
	if (isOrExpression(expr)) {
		log('OR expression found, treating as residual: %s', expr.toString());
		residual.push(expr);
		return;
	}

	// Try to extract constraint from binary comparison
	const constraint = extractBinaryConstraint(expr, attributeToTableMap);
	if (constraint) {
		constraints.push(constraint);
		log('Extracted constraint: %s %s %s (table: %s)',
			constraint.attributeId, constraint.op, constraint.value, constraint.targetRelation);
	} else {
		// Cannot convert to constraint - add to residual
		log('Cannot extract constraint from expression, adding to residual: %s', expr.toString());
		residual.push(expr);
	}
}

/**
 * Extract constraint from binary comparison expression
 */
function extractBinaryConstraint(
	expr: ScalarPlanNode,
	attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint | null {
	// Must be a binary operation
	if (expr.nodeType !== PlanNodeType.BinaryOp) {
		return null;
	}

	const binaryOp = expr as BinaryOpNode;
	const { left, right } = binaryOp;
	const operator = binaryOp.expression.operator;

	// Convert AST operator to constraint operator
	const constraintOp = mapOperatorToConstraint(operator);
	if (!constraintOp) {
		log('Unsupported operator for constraint: %s', operator);
		return null;
	}

	// Try column-constant pattern (column op constant)
	let columnRef: ColumnReferenceNode | null = null;
	let constant: SqlValue | undefined;
	let finalOp = constraintOp;

	if (isColumnReference(left) && isLiteralConstant(right)) {
		columnRef = left;
		constant = getLiteralValue(right);
	} else if (isLiteralConstant(left) && isColumnReference(right)) {
		// Reverse pattern (constant op column) - flip operator
		columnRef = right;
		constant = getLiteralValue(left);
		finalOp = flipOperator(constraintOp);
	}

	if (!columnRef) {
		log('No column-constant pattern found in binary expression');
		return null;
	}

	// Map attribute ID to table and column index
	const tableInfo = attributeToTableMap.get(columnRef.attributeId);
	if (!tableInfo) {
		log('No table mapping found for attribute ID %d', columnRef.attributeId);
		return null;
	}

	const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
	if (columnIndex === undefined) {
		log('No column index found for attribute ID %d', columnRef.attributeId);
		return null;
	}

	return {
		columnIndex,
		attributeId: columnRef.attributeId,
		op: finalOp,
		value: constant,
		usable: true, // Usable since we found table mapping
		sourceExpression: expr,
		targetRelation: tableInfo.relationName
	};
}

/**
 * Map AST operators to constraint operators
 */
function mapOperatorToConstraint(operator: string): ConstraintOp | null {
	switch (operator) {
		case '=': return '=';
		case '>': return '>';
		case '>=': return '>=';
		case '<': return '<';
		case '<=': return '<=';
		case 'LIKE': return 'LIKE';
		case 'GLOB': return 'GLOB';
		case 'MATCH': return 'MATCH';
		case 'IN': return 'IN';
		case 'NOT IN': return 'NOT IN';
		// Special handling for IS NULL / IS NOT NULL would go here
		default: return null;
	}
}

/**
 * Check if expression is an AND operation
 */
function isAndExpression(expr: ScalarPlanNode): boolean {
	return expr.nodeType === PlanNodeType.BinaryOp &&
		   (expr as BinaryOpNode).expression.operator === 'AND';
}

/**
 * Check if expression is an OR operation
 */
function isOrExpression(expr: ScalarPlanNode): boolean {
	return expr.nodeType === PlanNodeType.BinaryOp &&
		   (expr as BinaryOpNode).expression.operator === 'OR';
}

/**
 * Check if node is a column reference
 */
function isColumnReference(node: ScalarPlanNode): node is ColumnReferenceNode {
	return CapabilityDetectors.isColumnReference(node);
}

/**
 * Check if node is a literal constant
 */
function isLiteralConstant(node: ScalarPlanNode): node is LiteralNode {
	return node.nodeType === PlanNodeType.Literal;
}

/**
 * Get literal value from literal node
 */
function getLiteralValue(node: ScalarPlanNode): SqlValue {
	const literalNode = node as LiteralNode;
	return getSyncLiteral(literalNode.expression);
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
		case 'LIKE': return 'LIKE'; // Not flippable
		case 'GLOB': return 'GLOB'; // Not flippable
		case 'MATCH': return 'MATCH'; // Not flippable
		case 'IN': return 'IN'; // Not flippable in this context
		case 'NOT IN': return 'NOT IN'; // Not flippable in this context
		default: return op;
	}
}

/**
 * Extract constraints for a specific table from a relational plan
 * Analyzes all Filter nodes and join conditions that reference the table
 */
export function extractConstraintsForTable(
	plan: RelationalPlanNode,
	targetTableRelation: string
): PredicateConstraint[] {
	const constraints: PredicateConstraint[] = [];

	// Walk the plan tree looking for filter predicates
	walkPlanForPredicates(plan, (predicate, sourceNode) => {
		// Create table info for the target table only
		const tableInfos = createTableInfosFromPlan(plan).filter(
			info => info.relationName === targetTableRelation
		);

		if (tableInfos.length > 0) {
			const result = extractConstraints(predicate, tableInfos);
			const tableConstraints = result.constraintsByTable.get(targetTableRelation);
			if (tableConstraints) {
				constraints.push(...tableConstraints);
				log('Found %d constraints for table %s from %s',
					tableConstraints.length, targetTableRelation, sourceNode);
			}
		}
	});

	return constraints;
}

/**
 * Walk a plan tree and call callback for each predicate found
 */
function walkPlanForPredicates(
	plan: RelationalPlanNode,
	callback: (predicate: ScalarPlanNode, sourceNode: string) => void
): void {
	// This would need to be implemented based on the actual plan node types
	// For now, just a placeholder that would examine Filter nodes, Join conditions, etc.

	// TODO: Implement proper plan walking
	// - Check for FilterNode with predicate
	// - Check for JoinNode with condition
	// - Recursively walk children

	log('Plan walking for predicates not yet implemented - placeholder');
}

/**
 * Create table information from a relational plan
 */
function createTableInfosFromPlan(plan: RelationalPlanNode): TableInfo[] {
	const tableInfos: TableInfo[] = [];

	// This would analyze the plan to extract table references and their attributes
	// For now, just return empty array as placeholder

	log('Table info extraction from plan not yet implemented - placeholder');
	return tableInfos;
}

/**
 * Utility to create table info from a table reference node
 */
export function createTableInfoFromNode(node: RelationalPlanNode, relationName?: string): TableInfo {
	const attributes = node.getAttributes();
	const columnIndexMap = new Map<number, number>();

	// Map attribute IDs to column indices
	attributes.forEach((attr, index) => {
		columnIndexMap.set(attr.id, index);
	});

	return {
		relationName: relationName || node.toString(),
		attributes: attributes.map(attr => ({ id: attr.id, name: attr.name })),
		columnIndexMap
	};
}

/**
 * Create a residual filter predicate from constraints that weren't handled
 * This allows creating a filter function that can be applied at runtime
 */
export function createResidualFilter(
	originalPredicate: ScalarPlanNode,
	handledConstraints: PredicateConstraint[]
): ((row: Row) => boolean) | undefined {
	// If no constraints were handled, return undefined (original predicate still needed)
	if (handledConstraints.length === 0) {
		return undefined;
	}

	// TODO: Implement sophisticated residual filter construction
	// This would need to:
	// 1. Identify which parts of the original predicate were handled
	// 2. Construct a new predicate with only the unhandled parts
	// 3. Compile that predicate to a runtime function

	log('Residual filter construction not yet implemented - using original predicate');
	return undefined;
}
