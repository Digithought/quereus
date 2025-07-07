/**
 * Physical property utilities for the Titan optimizer
 * Provides helpers for handling ordering, unique keys, and property propagation
 */

import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Ordering specification for a column
 */
export interface Ordering {
	/** Column index */
	column: number;
	/** True for descending order */
	desc: boolean;
}

/**
 * Extract ordering from sort keys if they are trivial column references
 * Returns undefined if any sort key is not a simple column reference
 */
export function extractOrderingFromSortKeys(
	sortKeys: readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc' }[],
	sourceAttributes: readonly { id: number }[]
): Ordering[] | undefined {
	const ordering: Ordering[] = [];

	for (const sortKey of sortKeys) {
		// Check if this is a trivial column reference
		if (sortKey.expression.nodeType !== PlanNodeType.ColumnReference) {
			return undefined; // Non-trivial expression, cannot determine ordering
		}

		const columnRef = sortKey.expression as unknown as ColumnReferenceNode;

		// Find the column index in the source attributes
		const columnIndex = sourceAttributes.findIndex(attr => attr.id === columnRef.attributeId);
		if (columnIndex === -1) {
			return undefined; // Column not found in source
		}

		ordering.push({
			column: columnIndex,
			desc: sortKey.direction === 'desc'
		});
	}

	return ordering;
}

/**
 * Check if a scalar expression is a trivial column reference
 */
export function isTrivialColumnReference(expr: ScalarPlanNode): boolean {
	return expr.nodeType === PlanNodeType.ColumnReference;
}

/**
 * Extract column index from a column reference if it exists in the given attributes
 */
export function getColumnIndex(
	columnRef: ColumnReferenceNode,
	attributes: Array<{ id: number }>
): number | undefined {
	const index = attributes.findIndex(attr => attr.id === columnRef.attributeId);
	return index >= 0 ? index : undefined;
}

/**
 * Merge ordering requirements between parent and child
 * Returns undefined if orderings are incompatible
 */
export function mergeOrderings(
	parent: Ordering[] | undefined,
	child: Ordering[] | undefined
): Ordering[] | undefined {
	// If parent has no ordering requirements, use child's ordering
	if (!parent || parent.length === 0) {
		return child;
	}

	// If child provides no ordering, parent requirements cannot be satisfied
	if (!child || child.length === 0) {
		return undefined;
	}

	// Check if child ordering satisfies parent requirements
	if (parent.length > child.length) {
		return undefined; // Child provides fewer columns than parent needs
	}

	// Verify each parent requirement is satisfied by child
	for (let i = 0; i < parent.length; i++) {
		const parentOrder = parent[i];
		const childOrder = child[i];

		if (parentOrder.column !== childOrder.column ||
			parentOrder.desc !== childOrder.desc) {
			return undefined; // Ordering mismatch
		}
	}

	// Parent requirements are satisfied, return child's full ordering
	return child;
}

/**
 * Check if two orderings are compatible (one satisfies the other)
 */
export function orderingsCompatible(
	required: Ordering[] | undefined,
	provided: Ordering[] | undefined
): boolean {
	if (!required || required.length === 0) {
		return true; // No requirements
	}

	if (!provided || provided.length === 0) {
		return false; // Requirements exist but nothing provided
	}

	if (required.length > provided.length) {
		return false; // Not enough columns provided
	}

	// Check prefix compatibility
	for (let i = 0; i < required.length; i++) {
		const req = required[i];
		const prov = provided[i];

		if (req.column !== prov.column || req.desc !== prov.desc) {
			return false;
		}
	}

	return true;
}

/**
 * Check if orderings are exactly equal
 */
export function orderingsEqual(
	a: Ordering[] | undefined,
	b: Ordering[] | undefined
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		if (a[i].column !== b[i].column || a[i].desc !== b[i].desc) {
			return false;
		}
	}

	return true;
}

/**
 * Reverse an ordering (flip ASC/DESC)
 */
export function reverseOrdering(ordering: Ordering[]): Ordering[] {
	return ordering.map(ord => ({ ...ord, desc: !ord.desc }));
}

/**
 * Check if unique keys guarantee distinctness for given columns
 */
export function uniqueKeysImplyDistinct(
	uniqueKeys: number[][],
	projectedColumns: number[]
): boolean {
	// Check if any unique key is a subset of projected columns
	return uniqueKeys.some(key =>
		key.every(col => projectedColumns.includes(col))
	);
}

/**
 * Project unique keys through a projection
 * Returns keys that are still unique after projection
 */
export function projectUniqueKeys(
	uniqueKeys: number[][],
	columnMapping: Map<number, number> // oldColumn -> newColumn
): number[][] {
	const result: number[][] = [];

	for (const key of uniqueKeys) {
		const projectedKey: number[] = [];
		let keyIsValid = true;

		for (const col of key) {
			const newCol = columnMapping.get(col);
			if (newCol === undefined) {
				keyIsValid = false;
				break; // Key column not in projection
			}
			projectedKey.push(newCol);
		}

		if (keyIsValid) {
			result.push(projectedKey);
		}
	}

	return result;
}
