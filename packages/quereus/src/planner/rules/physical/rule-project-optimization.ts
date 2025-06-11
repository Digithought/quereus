/**
 * Rule: Project Optimization
 *
 * Transforms: ProjectNode → ProjectNode (optimized)
 * Conditions: When project node's source needs optimization
 * Benefits: Ensures project nodes have optimized sources and proper physical properties
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { Optimizer } from '../../optimizer.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { PlanNode as BasePlanNode } from '../../nodes/plan-node.js';

const log = createLogger('optimizer:rule:project-optimization');

export function ruleProjectOptimization(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	// Guard: only apply to ProjectNode
	if (!(node instanceof ProjectNode)) {
		return null;
	}

	log('Optimizing ProjectNode %s', node.id);

	// Optimize the source
	const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

	// If source didn't change, just ensure physical properties are set
	if (optimizedSource === node.source) {
		if (!node.physical) {
			BasePlanNode.setDefaultPhysical(node, {
				estimatedRows: optimizedSource.estimatedRows,
				deterministic: true,
				readonly: true
			});
			log('Set physical properties on existing ProjectNode');
			return node;
		}
		return null; // No change needed
	}

	// Source changed - create new project node with optimized source
	const result = new ProjectNode(node.scope, optimizedSource, node.projections);

	// Set physical properties
	BasePlanNode.setDefaultPhysical(result, {
		estimatedRows: optimizedSource.estimatedRows,
		deterministic: true,
		readonly: true
	});

	log('Created optimized ProjectNode with new source');
	return result;
}
