/**
 * Rule: Materialization Advisory
 *
 * Transforms: Any relational node → CacheNode (when beneficial)
 * Conditions: Node would benefit from caching based on reference analysis
 * Benefits: Reduces redundant computation for repeated scans and loop contexts
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { Optimizer } from '../../optimizer.js';
import { MaterializationAdvisory } from '../../cache/materialization-advisory.js';

const log = createLogger('optimizer:rule:materialization-advisory');

export function ruleMaterializationAdvisory(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	// This is a global rule that analyzes the entire tree
	// It should only be applied to root nodes to avoid duplicate analysis

	// Simple heuristic: only apply to certain root-level node types
	// to avoid analyzing the same tree multiple times
	const rootNodeTypes = new Set([
		'Select', 'Insert', 'Update', 'Delete', 'Block', 'CTE'
	]);

	if (!rootNodeTypes.has(node.nodeType)) {
		return null;
	}

	log('Applying materialization advisory to tree rooted at %s', node.nodeType);

	try {
		// Create advisory with current tuning parameters
		const advisory = new MaterializationAdvisory(optimizer.tuning);

		// Analyze the tree for caching opportunities
		const recommendations = advisory.analyzeTree(node);

		// Count how many cache recommendations were made
		const cacheCount = Array.from(recommendations.values())
			.filter(rec => rec.shouldCache).length;

		if (cacheCount === 0) {
			log('No caching opportunities identified');
			return null;
		}

		log('Found %d caching opportunities', cacheCount);

		// Apply the caching recommendations
		const cachedTree = advisory.applyCaching(node, recommendations);

		// If the tree was modified, return the new tree
		if (cachedTree !== node) {
			log('Applied materialization advisory, tree modified');
			return cachedTree;
		}

		return null;

	} catch (error) {
		log('Error in materialization advisory: %s', error);
		// Don't fail optimization - just skip caching
		return null;
	}
}

function meetsPreConditions(node: PlanNode): boolean {
	// All nodes can potentially benefit from materialization analysis
	return true;
}
