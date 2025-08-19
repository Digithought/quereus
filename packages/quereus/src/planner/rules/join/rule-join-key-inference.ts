import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';

const log = createLogger('optimizer:rule:join-key-inference');

/**
 * Rule: Join Key Inference
 *
 * Detect simple equi-join predicates (left.col = right.pk) and propagate
 * inner/cross join unique keys (already handled by JoinNode.computePhysical),
 * with a hook for future FK->PK inference (not implemented here yet).
 */
export function ruleJoinKeyInference(node: PlanNode, _context: OptContext): PlanNode | null {
  if (!(node instanceof JoinNode)) return null;
  if (node.joinType !== 'inner' && node.joinType !== 'cross') return null;

  const cond = node.getJoinCondition();
  if (!cond || !(cond instanceof BinaryOpNode)) return null;
  if (cond.expression.operator !== '=') return null;

  // Simple left.col = right.col pattern check; placeholder for future FK->PK detection
  const leftIsCol = cond.left instanceof ColumnReferenceNode;
  const rightIsCol = cond.right instanceof ColumnReferenceNode;
  if (!leftIsCol || !rightIsCol) return null;

  log('Detected equi-join predicate; JoinNode.computePhysical will preserve side keys');
  // No structural change needed now; computePhysical on JoinNode already preserves side keys
  return null;
}


