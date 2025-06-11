/**
 * Rule: Sort Optimization
 *
 * Transforms: SortNode → SortNode (optimized)
 * Conditions: When sort node needs optimization or source changes
 * Benefits: Ensures proper physical properties and optimizes child nodes
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { Optimizer } from '../../optimizer.js';
import { SortNode } from '../../nodes/sort.js';
import { PlanNode as BasePlanNode } from '../../nodes/plan-node.js';

const log = createLogger('optimizer:rule:sort-optimization');

export function ruleSortOptimization(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	// Guard: only apply to SortNode
	if (!(node instanceof SortNode)) {
		return null;
	}

	log('Optimizing SortNode %s', node.id);

	// Sort is already a physical node in our current design
	// Just optimize its source
	const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;
	if (optimizedSource === node.source) {
		// No change in source, but still need to ensure physical properties are set
		if (!node.physical) {
			BasePlanNode.setDefaultPhysical(node, {
				ordering: node.sortKeys.map((key, idx) => ({
					column: idx,
					desc: key.direction === 'desc'
				})),
				estimatedRows: optimizedSource.estimatedRows,
				deterministic: true,
				readonly: true
			});
			log('Set physical properties on existing SortNode');
			return node;
		}
		return null; // No change
	}

	// Source changed - create new sort node
	const newSort = new SortNode(node.scope, optimizedSource, node.sortKeys);

	// Set physical properties
	BasePlanNode.setDefaultPhysical(newSort, {
		ordering: node.sortKeys.map((key, idx) => ({
			column: idx,
			desc: key.direction === 'desc'
		})),
		estimatedRows: optimizedSource.estimatedRows,
		deterministic: true,
		readonly: true
	});

	log('Created optimized SortNode with new source');
	return newSort;
}
