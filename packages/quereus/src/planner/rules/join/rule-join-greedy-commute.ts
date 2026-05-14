import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { hasSingletonFd } from '../../util/fd-utils.js';

const log = createLogger('optimizer:rule:join-greedy-commute');

/** True when the relation provably emits at most one row. */
function isSingleton(node: RelationalPlanNode): boolean {
	const colCount = node.getAttributes().length;
	if (colCount === 0) return node.physical?.estimatedRows === 1;
	return hasSingletonFd(node.physical?.fds, colCount);
}

/**
 * Rule: Join Greedy Commute
 *
 * Simple heuristic: for INNER joins, prefer the smaller input on the left to drive nested-loop-like cost.
 * This uses children estimatedRows (influenced by pushdown/growth) and swaps left/right when beneficial.
 *
 * Safety:
 * - INNER joins are commutative; ColumnReferenceNode uses attribute IDs, so swapping sides preserves semantics.
 * - We do NOT change associativity; we only commute immediate children of a JoinNode.
 */
export function ruleJoinGreedyCommute(node: PlanNode, _context: OptContext): PlanNode | null {
  if (!(node instanceof JoinNode)) return null;
  if (node.joinType !== 'inner' && node.joinType !== 'cross') return null;

  const leftRows = node.getLeftSource().estimatedRows ?? Number.POSITIVE_INFINITY;
  const rightRows = node.getRightSource().estimatedRows ?? Number.POSITIVE_INFINITY;

  // Prefer known finite estimatedRows; also detect <=1 row driver on either side
  const leftIsSingleton = isSingleton(node.getLeftSource());
  const rightIsSingleton = isSingleton(node.getRightSource());

  // If right is strictly better driver (smaller or singleton), swap
  const shouldSwap = (rightIsSingleton && !leftIsSingleton) || (!rightIsSingleton && !leftIsSingleton && rightRows < leftRows);
  if (!shouldSwap) return null;

  log('Commuting join children to place smaller input on the left (leftRows=%s, rightRows=%s)', String(leftRows), String(rightRows));

  // Swap children; condition stays the same (attribute IDs are stable)
  const swapped = new JoinNode(
    node.scope,
    node.getRightSource() as RelationalPlanNode,
    node.getLeftSource() as RelationalPlanNode,
    node.getJoinType(),
    node.getJoinCondition(),
    node.getUsingColumns()
  );

  return swapped;
}


