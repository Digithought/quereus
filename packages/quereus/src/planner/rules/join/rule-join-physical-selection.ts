/**
 * Rule: Join Physical Selection
 *
 * Required Characteristics:
 * - Node must be a logical JoinNode (not already a physical join)
 * - Node must have an equi-join predicate for hash join consideration
 *
 * Applied When:
 * - Logical JoinNode with equi-join predicates where hash join is cheaper than nested loop
 *
 * Benefits: Replaces O(n*m) nested loop with O(n+m) hash join for equi-joins
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, Attribute } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { BloomJoinNode, type EquiJoinPair } from '../../nodes/bloom-join-node.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { nestedLoopJoinCost, hashJoinCost } from '../../cost/index.js';

const log = createLogger('optimizer:rule:join-physical-selection');

/**
 * Extract equi-join pairs and residual predicates from an ON condition.
 * Returns null if no equi-pairs found.
 */
function extractEquiPairs(
	condition: ScalarPlanNode | undefined,
	leftAttrIds: Set<number>,
	rightAttrIds: Set<number>
): { equiPairs: EquiJoinPair[]; residual: ScalarPlanNode | undefined } | null {
	if (!condition) return null;

	const norm = normalizePredicate(condition);
	const equiPairs: EquiJoinPair[] = [];
	const residuals: ScalarPlanNode[] = [];

	// Walk AND-tree and classify each conjunct
	const stack: ScalarPlanNode[] = [norm];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode && n.expression.operator === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}

		// Check for equi-join: col_ref = col_ref across left/right
		let isEqui = false;
		if (n instanceof BinaryOpNode && n.expression.operator === '=') {
			if (n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode) {
				const lId = n.left.attributeId;
				const rId = n.right.attributeId;

				if (leftAttrIds.has(lId) && rightAttrIds.has(rId)) {
					equiPairs.push({ leftAttrId: lId, rightAttrId: rId });
					isEqui = true;
				} else if (leftAttrIds.has(rId) && rightAttrIds.has(lId)) {
					equiPairs.push({ leftAttrId: rId, rightAttrId: lId });
					isEqui = true;
				}
			}
		}

		if (!isEqui) {
			residuals.push(n);
		}
	}

	if (equiPairs.length === 0) return null;

	// Combine residuals back into an AND-tree
	let residual: ScalarPlanNode | undefined;
	if (residuals.length > 0) {
		residual = residuals.reduce((acc, cur) =>
			new BinaryOpNode(cur.scope, { type: 'binary', operator: 'AND' } as any, acc, cur)
		);
	}

	return { equiPairs, residual };
}

export function ruleJoinPhysicalSelection(node: PlanNode, _context: OptContext): PlanNode | null {
	// Guard: only apply to logical JoinNode, not already-physical nodes
	if (!(node instanceof JoinNode)) return null;

	const joinType = node.joinType;

	// Only support INNER and LEFT for now (matching current nested-loop scope)
	if (joinType !== 'inner' && joinType !== 'left') return null;

	// Build attribute ID sets for left and right
	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();
	const leftAttrIds = new Set(leftAttrs.map(a => a.id));
	const rightAttrIds = new Set(rightAttrs.map(a => a.id));

	// Try to extract equi-join pairs from condition (or USING)
	let extracted: { equiPairs: EquiJoinPair[]; residual: ScalarPlanNode | undefined } | null = null;

	if (node.condition) {
		extracted = extractEquiPairs(node.condition, leftAttrIds, rightAttrIds);
	} else if (node.usingColumns) {
		// Convert USING columns to equi-pairs
		const equiPairs: EquiJoinPair[] = [];
		for (const colName of node.usingColumns) {
			const lowerName = colName.toLowerCase();
			const leftAttr = leftAttrs.find(a => a.name.toLowerCase() === lowerName);
			const rightAttr = rightAttrs.find(a => a.name.toLowerCase() === lowerName);
			if (leftAttr && rightAttr) {
				equiPairs.push({ leftAttrId: leftAttr.id, rightAttrId: rightAttr.id });
			}
		}
		if (equiPairs.length > 0) {
			extracted = { equiPairs, residual: undefined };
		}
	}

	if (!extracted || extracted.equiPairs.length === 0) return null;

	// Cost comparison: hash join vs nested loop
	const leftRows = node.left.estimatedRows ?? 100;
	const rightRows = node.right.estimatedRows ?? 100;

	// For hash join, build side is the smaller input
	const buildRows = Math.min(leftRows, rightRows);
	const probeRows = Math.max(leftRows, rightRows);
	const hashCost = hashJoinCost(buildRows, probeRows);
	const nlCost = nestedLoopJoinCost(leftRows, rightRows);

	if (hashCost >= nlCost) {
		log('Hash join not cheaper (hash=%.2f, nl=%.2f) for %d x %d rows', hashCost, nlCost, leftRows, rightRows);
		return null;
	}

	log('Selecting hash join (hash=%.2f, nl=%.2f) for %d x %d rows', hashCost, nlCost, leftRows, rightRows);

	// Determine build and probe sides: build=smaller, probe=larger
	// left=probe, right=build by convention; swap if needed
	let probeSource = node.left;
	let buildSource = node.right;
	let equiPairs = extracted.equiPairs;

	if (leftRows < rightRows) {
		// Swap: left becomes build, right becomes probe
		probeSource = node.right;
		buildSource = node.left;
		// Flip equi-pair directions
		equiPairs = extracted.equiPairs.map(p => ({
			leftAttrId: p.rightAttrId,
			rightAttrId: p.leftAttrId
		}));
	}

	// Preserve attribute IDs from the logical JoinNode
	const preserveAttrs = node.getAttributes().slice() as Attribute[];

	const bloomJoin = new BloomJoinNode(
		node.scope,
		probeSource,
		buildSource,
		joinType,
		equiPairs,
		extracted.residual,
		preserveAttrs
	);

	return bloomJoin;
}
