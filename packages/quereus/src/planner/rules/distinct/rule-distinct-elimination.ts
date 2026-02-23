import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { DistinctNode } from '../../nodes/distinct-node.js';

const log = createLogger('optimizer:rule:distinct-elimination');

/**
 * Rule: DISTINCT Elimination
 *
 * When a DistinctNode's source already guarantees unique rows (via logical keys
 * from RelationType or physical uniqueKeys), the DISTINCT is redundant and can
 * be removed.
 *
 * Checks both:
 * 1. Physical uniqueKeys (from computePhysical, available after physical pass)
 * 2. Logical keys (from RelationType.keys, available at any time)
 *
 * A key that is present in the source proves it already produces unique rows —
 * DISTINCT is a no-op.
 */
export function ruleDistinctElimination(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof DistinctNode)) return null;

	// Check physical uniqueKeys (available if physical pass has run or compute is triggered)
	const sourcePhys = node.source.physical;
	if (sourcePhys?.uniqueKeys && sourcePhys.uniqueKeys.length > 0) {
		log('Eliminating redundant DISTINCT: source has physical uniqueKeys %j', sourcePhys.uniqueKeys);
		return node.source;
	}

	// Check logical keys from RelationType
	// If the source's logical type declares any key, the source already produces
	// unique rows (since any superset of a key is also unique).
	const sourceType = node.source.getType();
	if (sourceType.keys && sourceType.keys.length > 0) {
		log('Eliminating redundant DISTINCT: source has logical keys %j', sourceType.keys);
		return node.source;
	}

	return null;
}
