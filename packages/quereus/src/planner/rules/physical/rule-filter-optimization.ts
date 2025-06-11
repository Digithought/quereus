/**
 * Rule: Filter Optimization
 *
 * Transforms: FilterNode → FilterNode (optimized)
 * Conditions: When filter node's source needs optimization
 * Benefits: Ensures filter nodes have optimized sources and proper physical properties
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { Optimizer } from '../../optimizer.js';
import { FilterNode } from '../../nodes/filter.js';
import { PlanNode as BasePlanNode } from '../../nodes/plan-node.js';

const log = createLogger('optimizer:rule:filter-optimization');

export function ruleFilterOptimization(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	// Guard: only apply to FilterNode
	if (!(node instanceof FilterNode)) {
		return null;
	}

	log('Optimizing FilterNode %s', node.id);

	// Optimize the source
	const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

	// If source didn't change, just ensure physical properties are set
	if (optimizedSource === node.source) {
		if (!node.physical) {
			// Filter preserves most properties but may reduce row count
			const sourceRows = optimizedSource.estimatedRows;
			const filteredRows = sourceRows ? Math.ceil(sourceRows * 0.3) : undefined; // Assume 30% selectivity

			BasePlanNode.setDefaultPhysical(node, {
				estimatedRows: filteredRows,
				deterministic: true,
				readonly: true
			});
			log('Set physical properties on existing FilterNode');
			return node;
		}
		return null; // No change needed
	}

	// Source changed - create new filter node with optimized source
	const result = new FilterNode(node.scope, optimizedSource, node.predicate);

	// Set physical properties
	const sourceRows = optimizedSource.estimatedRows;
	const filteredRows = sourceRows ? Math.ceil(sourceRows * 0.3) : undefined; // Assume 30% selectivity

	BasePlanNode.setDefaultPhysical(result, {
		estimatedRows: filteredRows,
		deterministic: true,
		readonly: true
	});

	log('Created optimized FilterNode with new source');
	return result;
}
