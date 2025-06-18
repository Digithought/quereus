/**
 * Rule: Mark Physical (Fallback)
 *
 * Transforms: Any logical node → Same node (marked as physical)
 * Conditions: When no other rule has made the node physical
 * Benefits: Ensures all nodes become physical even if no specific transformation is needed
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';

const log = createLogger('optimizer:rule:mark-physical');

export function ruleMarkPhysical(node: PlanNode, _context: OptContext): PlanNode | null {
	// This is a fallback rule - only apply if the node is not already physical
	if (node.physical) {
		return null; // Already physical
	}

	// Some node types cannot be made physical directly (like AggregateNode)
	// These should have been handled by specific transformation rules
	const cannotBePhysical = new Set([
		'Aggregate', // Should be transformed to StreamAggregate/HashAggregate
	]);

	if (cannotBePhysical.has(node.nodeType)) {
		log('Cannot mark %s as physical - requires transformation', node.nodeType);
		return null; // Let the optimizer handle this as an error
	}

	log('Marking %s as physical (fallback rule)', node.nodeType);

	// Return the node - framework will set physical properties via markPhysical()
	// Don't hardcode properties, let the framework compute them from children
	return node;
}
