/**
 * Physical property utilities for the Titan optimizer
 * Provides helpers for handling ordering, unique keys, and property propagation
 */

import type { PhysicalProperties } from './nodes/plan-node.js';

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
 * Join type for property combination
 */
export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross';

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
 * Combine unique keys from left and right sides of a join
 */
export function combineUniqueKeys(
	left: number[][],
	right: number[][],
	joinType: JoinType,
	leftColumnOffset: number = 0,
	rightColumnOffset?: number
): number[][] {
	const result: number[][] = [];

	// Calculate right column offset if not provided
	if (rightColumnOffset === undefined) {
		rightColumnOffset = leftColumnOffset + Math.max(...left.flat(), 0) + 1;
	}

	switch (joinType) {
		case 'inner':
		case 'cross':
			// Inner join: unique keys from both sides remain unique
			// Add left side keys (unchanged)
			result.push(...left);
			// Add right side keys (with column offset)
			result.push(...right.map(key => key.map(col => col + rightColumnOffset!)));
			break;

		case 'left':
			// Left outer join: left side keys remain unique, right side keys may have nulls
			result.push(...left);
			break;

		case 'right':
			// Right outer join: right side keys remain unique, left side keys may have nulls
			result.push(...right.map(key => key.map(col => col + rightColumnOffset!)));
			break;

		case 'full':
			// Full outer join: no keys remain unique due to potential nulls
			break;
	}

	return result;
}

/**
 * Propagate constant flag from children to parent
 */
export function propagateConstantFlag(children: PhysicalProperties[]): boolean {
	// A node is constant if all its children are constant
	return children.length > 0 && children.every(child => child.constant === true);
}

/**
 * Estimate result rows for common operations
 */
export function estimateResultRows(
	operation: 'filter' | 'aggregate' | 'join' | 'distinct' | 'limit',
	...params: any[]
): number {
	switch (operation) {
		case 'filter': {
			const [inputRows, selectivity = 0.3] = params;
			return Math.max(1, Math.floor(inputRows * selectivity));
		}

		case 'aggregate': {
			const [inputRows, groupByCount] = params;
			if (groupByCount === 0) {
				return 1; // Single aggregate result
			}
			// Estimate grouping factor
			const groupingFactor = Math.min(0.8, Math.max(0.1, groupByCount * 0.2));
			return Math.max(1, Math.floor(inputRows * groupingFactor));
		}

		case 'join': {
			const [leftRows, rightRows, joinType = 'inner'] = params;
			switch (joinType) {
				case 'inner':
				case 'cross':
					return leftRows * rightRows;
				case 'left':
					return Math.max(leftRows, Math.floor(leftRows * rightRows * 0.1));
				case 'right':
					return Math.max(rightRows, Math.floor(leftRows * rightRows * 0.1));
				case 'full':
					return leftRows + rightRows;
				default:
					return Math.max(leftRows, rightRows);
			}
		}

		case 'distinct': {
			const [inputRows] = params;
			// Assume 70% unique rows
			return Math.max(1, Math.floor(inputRows * 0.7));
		}

		case 'limit': {
			const [inputRows, limitValue, offset = 0] = params;
			return Math.min(inputRows, Math.max(0, limitValue - offset));
		}

		default:
			throw new Error(`Unknown operation: ${operation}`);
	}
}
