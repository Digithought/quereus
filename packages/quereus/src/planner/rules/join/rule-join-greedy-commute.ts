import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';

const log = createLogger('optimizer:rule:join-greedy-commute');

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
  const leftIsSingleton = node.getLeftSource().physical.uniqueKeys?.some(k => k.length === 0) === true;
  const rightIsSingleton = node.getRightSource().physical.uniqueKeys?.some(k => k.length === 0) === true;

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


