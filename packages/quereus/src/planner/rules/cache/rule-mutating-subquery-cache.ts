/**
 * Rule: Mutating Subquery Cache Injection
 *
 * Transforms: JoinNode with mutating right side → JoinNode with cached right side
 * Conditions: Right side contains operations with readonly=false physical property
 * Benefits: Prevents mutating subqueries from being executed multiple times in nested loop joins
 */

import { createLogger } from '../../../common/logger.js';
import { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { CacheNode } from '../../nodes/cache-node.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';

const log = createLogger('optimizer:rule:mutating-subquery-cache');

export function ruleMutatingSubqueryCache(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: only apply to JoinNode
	if (!(node instanceof JoinNode)) {
		return null;
	}

	log('Checking JoinNode for operations with side effects on right side');

	// Check if the right side contains operations with side effects
	const rightSide = node.right;
	const hasSideEffects = containsOperationsWithSideEffects(rightSide);

	if (!hasSideEffects) {
		log('Right side does not contain operations with side effects, skipping');
		return null;
	}

	// Check if right side is already cached
	if (rightSide.nodeType === PlanNodeType.Cache) {
		log('Right side is already cached, skipping');
		return null;
	}

	log('Detected operations with side effects on right side of join, injecting cache');

	// Calculate appropriate cache threshold
	const estimatedRows = rightSide.estimatedRows ?? context.tuning.defaultRowEstimate;
	const threshold = Math.min(
		Math.max(estimatedRows * context.tuning.join.cacheThresholdMultiplier, 1000),
		context.tuning.join.maxCacheThreshold
	);

	// Wrap the right side with a cache node
	const cachedRightSide = new CacheNode(
		rightSide.scope,
		rightSide,
		'memory',
		threshold
	);

	// Create new join node with cached right side
	const result = new JoinNode(
		node.scope,
		node.left, // Left side unchanged
		cachedRightSide, // Right side now cached
		node.joinType,
		node.condition,
		node.usingColumns
	);

	log('Successfully injected cache for operations with side effects (threshold: %d)', threshold);
	return result;
}

/**
 * Recursively check if a plan tree contains operations with side effects
 */
function containsOperationsWithSideEffects(node: PlanNode): boolean {
	// Check if this node has side effects using physical properties
	if (hasNodeSideEffects(node)) {
		return true;
	}

	// Recursively check children
	for (const child of node.getChildren()) {
		if (containsOperationsWithSideEffects(child)) {
			return true;
		}
	}

	// Check relational children if available
	if ('getRelations' in node) {
		for (const relation of (node as any).getRelations()) {
			if (containsOperationsWithSideEffects(relation)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Check if a node has side effects using physical properties
 */
function hasNodeSideEffects(node: PlanNode): boolean {
	// By the time rules run, all children should have physical properties set by the framework
	if (!node.physical) {
		throw new Error(`Internal error: Node ${node.nodeType}:${node.id} missing physical properties during rule application`);
	}

	return PlanNode.hasSideEffects(node.physical);
}
