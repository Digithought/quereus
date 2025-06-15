/**
 * Physical property utilities for the Titan optimizer
 * Provides helpers for handling ordering, unique keys, and property propagation
 */

import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { PhysicalProperties } from '../nodes/plan-node.js';

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
 * Propagate deterministic flag from children to parent
 */
export function propagateDeterministicFlag(children: PhysicalProperties[]): boolean {
	// A node is deterministic if all its children are deterministic
	return children.length === 0 || children.every(child => child.deterministic !== false);
}

/**
 * Propagate readonly flag from children to parent
 */
export function propagateReadonlyFlag(children: PhysicalProperties[]): boolean {
	// A node is readonly if all its children are readonly
	return children.length === 0 || children.every(child => child.readonly !== false);
}

/**
 * Propagate idempotent flag from children to parent
 */
export function propagateIdempotentFlag(children: PhysicalProperties[]): boolean {
	// A node is idempotent if all its children are idempotent
	return children.length === 0 || children.every(child => child.idempotent !== false);
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
			quereusError(`Unknown operation: ${operation}`, StatusCode.INTERNAL);
	}
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
 * Create ordering from column list
 */
export function createOrdering(columns: number[], desc: boolean = false): Ordering[] {
	return columns.map(column => ({ column, desc }));
}

/**
 * Extract column indexes from ordering
 */
export function orderingColumns(ordering: Ordering[] | undefined): number[] {
	return ordering?.map(ord => ord.column) ?? [];
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

/**
 * Merge physical properties from multiple children
 */
export function mergePhysicalProperties(
	children: PhysicalProperties[],
	overrides: Partial<PhysicalProperties> = {}
): PhysicalProperties {
	return {
		ordering: overrides.ordering,
		estimatedRows: overrides.estimatedRows,
		uniqueKeys: overrides.uniqueKeys ?? [],
		readonly: overrides.readonly ?? propagateReadonlyFlag(children),
		deterministic: overrides.deterministic ?? propagateDeterministicFlag(children),
		constant: overrides.constant ?? propagateConstantFlag(children),
		idempotent: overrides.idempotent ?? propagateIdempotentFlag(children)
	};
}
