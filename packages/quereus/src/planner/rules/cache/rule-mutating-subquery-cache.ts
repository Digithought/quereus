/**
 * Rule: Mutating Subquery Cache Injection
 *
 * Required Characteristics:
 * - Node must be a join operation (JoinCapable interface)
 * - Right side must contain operations with side effects (readonly=false)
 * - Right side must not already be cached
 *
 * Applied When:
 * - Join has mutating operations on right side that could be executed multiple times
 *
 * Benefits: Prevents mutating subqueries from being executed multiple times in nested loop joins
 */

import { createLogger } from '../../../common/logger.js';
import { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { CacheNode } from '../../nodes/cache-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { PlanNodeCharacteristics, CapabilityDetectors, CachingAnalysis, type JoinCapable } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:mutating-subquery-cache');

export function ruleMutatingSubqueryCache(node: PlanNode, _context: OptContext): PlanNode | null {
	// Guard: node must support join operations
	if (!CapabilityDetectors.isJoin(node)) {
		return null;
	}

	log('Checking join operation for side effects on right side');

	// Get join-specific characteristics
	const joinNode = node as JoinCapable;
	const rightSide = joinNode.getRightSource();

	// Check if right side contains operations with side effects
	const hasSideEffects = containsOperationsWithSideEffects(rightSide);
	if (!hasSideEffects) {
		log('Right side does not contain operations with side effects, skipping');
		return null;
	}

	// Check if right side is already cached
	if (CapabilityDetectors.isCached(rightSide) && rightSide.isCached()) {
		log('Right side is already cached, skipping');
		return null;
	}

	log('Detected operations with side effects on right side of join, injecting cache');

	// Calculate appropriate cache threshold using characteristics
	const threshold = CachingAnalysis.getCacheThreshold(rightSide);

	// Wrap the right side with a cache node
	const cachedRightSide = new CacheNode(
		rightSide.scope,
		rightSide,
		'memory',
		threshold
	);

	// Create new join node with cached right side
	// Note: We still need to use specific constructor since we don't have a generic join builder yet
	const result = new JoinNode(
		node.scope,
		joinNode.getLeftSource(),
		cachedRightSide,
		joinNode.getJoinType(),
		joinNode.getJoinCondition() ?? undefined,
		(node as any).usingColumns // TODO: Add to JoinCapable interface
	);

	log('Successfully injected cache for operations with side effects (threshold: %d)', threshold);
	return result;
}

/**
 * Recursively check if a plan tree contains operations with side effects
 * Uses characteristics-based analysis instead of hard-coded node type checks
 */
function containsOperationsWithSideEffects(node: PlanNode): boolean {
	// Check this node's characteristics
	if (PlanNodeCharacteristics.hasSideEffects(node)) {
		return true;
	}

	// Recursively check all children
	for (const child of node.getChildren()) {
		if (containsOperationsWithSideEffects(child)) {
			return true;
		}
	}

	// Check relational children if available (preserved for compatibility)
	// TODO: This could be made more characteristics-based by detecting nodes that expose relations
	if ('getRelations' in node && typeof (node as any).getRelations === 'function') {
		for (const relation of (node as any).getRelations()) {
			if (containsOperationsWithSideEffects(relation)) {
				return true;
			}
		}
	}

	return false;
}
