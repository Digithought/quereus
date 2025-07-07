/**
 * Utility to detect correlated subqueries
 * A subquery is correlated if it references columns from outer query scopes
 */

import { isRelationalNode, type PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Detects if a subquery is correlated by checking if it references any attributes
 * that are not defined within its own scope.
 */
export function isCorrelatedSubquery(subqueryNode: RelationalPlanNode): boolean {
	// Collect all attributes defined within the subquery
	const definedAttributes = new Set<number>();
	collectDefinedAttributes(subqueryNode, definedAttributes);

	// Check if any column references use attributes not defined within the subquery
	return hasExternalReferences(subqueryNode, definedAttributes);
}

/**
 * Recursively collect all attributes defined by relational nodes within a subtree
 */
function collectDefinedAttributes(node: PlanNode, definedAttributes: Set<number>): void {
	// If this is a relational node, add its attributes
	const isRelational = isRelationalNode(node);
	if (isRelational) {
		const attributes = node.getAttributes();
		for (const attr of attributes) {
			definedAttributes.add(attr.id);
		}
	}

	// Recursively process all children
	const children = node.getChildren();
	for (const child of children) {
		collectDefinedAttributes(child, definedAttributes);
	}

	// Also process relational children if any
	if (isRelational) {
		const relations = node.getRelations();
		for (const relation of relations) {
			collectDefinedAttributes(relation, definedAttributes);
		}
	}
}

/**
 * Check if the subtree contains any column references to attributes not in the defined set
 */
function hasExternalReferences(node: PlanNode, definedAttributes: Set<number>): boolean {
	// Check if this is a column reference
	if (node.nodeType === PlanNodeType.ColumnReference) {
		const colRef = node as ColumnReferenceNode;
		// If the referenced attribute is not defined within the subquery, it's an external reference
		if (!definedAttributes.has(colRef.attributeId)) {
			return true; // Found a correlated reference
		}
	}

	// Check all children
	const children = node.getChildren();
	for (const child of children) {
		if (hasExternalReferences(child, definedAttributes)) {
			return true;
		}
	}

	// Also check relational children if any
	if (isRelationalNode(node)) {
		const relations = node.getRelations();
		for (const relation of relations) {
			if (hasExternalReferences(relation, definedAttributes)) {
				return true;
			}
		}
	}

	return false;
}
