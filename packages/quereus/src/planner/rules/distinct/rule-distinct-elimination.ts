import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { hasAnyKey, hasSingletonFd } from '../../util/fd-utils.js';

const log = createLogger('optimizer:rule:distinct-elimination');

/**
 * Rule: DISTINCT Elimination
 *
 * When a DistinctNode's source already guarantees unique rows, the DISTINCT is
 * redundant and can be removed.
 *
 * Sources of uniqueness proof:
 * 1. Logical keys (`RelationType.keys`) — schema-declared, available at any time.
 * 2. Physical FD set — encodes derived keys as `K → all_other_cols` FDs, plus
 *    the singleton `∅ → all_cols` for at-most-one-row claims.
 *
 * A non-empty key proof on the source proves it already produces unique rows —
 * DISTINCT is a no-op.
 */
export function ruleDistinctElimination(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof DistinctNode)) return null;

	// Logical keys (RelationType.keys) are the schema-level claim.
	const sourceType = node.source.getType();
	if (sourceType.keys && sourceType.keys.length > 0) {
		log('Eliminating redundant DISTINCT: source has logical keys %j', sourceType.keys);
		return node.source;
	}

	// Physical FDs: an FD whose determinants form a non-trivial superkey of the
	// source columns proves uniqueness; the singleton `∅ → all_cols` proves
	// at-most-one-row (also unique).
	const sourcePhys = node.source.physical;
	const colCount = node.source.getAttributes().length;
	if (hasAnyKey(sourcePhys?.fds, colCount) || hasSingletonFd(sourcePhys?.fds, colCount)) {
		log('Eliminating redundant DISTINCT: source FDs imply unique rows');
		return node.source;
	}

	return null;
}
