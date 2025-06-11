/**
 * Rule: CTE Optimization
 *
 * Transforms: CTENode → CTENode (with caching when beneficial)
 * Conditions: CTE would benefit from materialization/caching
 * Benefits: Reduces redundant computation for repeated CTE access
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { Optimizer } from '../../optimizer.js';
import { CTENode } from '../../nodes/cte-node.js';
import { CacheNode } from '../../nodes/cache-node.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';

const log = createLogger('optimizer:rule:cte-optimization');

export function ruleCteOptimization(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	// Guard: only apply to CTENode
	if (!(node instanceof CTENode)) {
		return null;
	}

	log('Optimizing CTENode %s', node.cteName);

	const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

	// Heuristics for when to cache CTEs:
	// 1. CTE has materialization hint
	// 2. CTE is estimated to be reasonably sized
	// 3. CTE is not already cached
	const sourceSize = optimizedSource.estimatedRows ?? optimizer.tuning.defaultRowEstimate;
	const shouldCache = (
		node.materializationHint === 'materialized' ||
		(sourceSize > 0 && sourceSize < optimizer.tuning.cte.maxSizeForCaching)
	) && optimizedSource.nodeType !== PlanNodeType.Cache;

	if (shouldCache) {
		log('Adding cache to CTE %s (estimated rows: %d)', node.cteName, sourceSize);
		const cacheThreshold = Math.min(
			sourceSize * optimizer.tuning.cte.cacheThresholdMultiplier,
			optimizer.tuning.cte.maxCacheThreshold
		);
		const cachedSource = new CacheNode(
			optimizedSource.scope,
			optimizedSource,
			'memory',
			cacheThreshold
		);

		const result = new CTENode(
			node.scope,
			node.cteName,
			node.columns,
			cachedSource,
			node.materializationHint,
			node.isRecursive
		);

		log('Created CTE with caching');
		return result;
	}

	// If source was optimized but no caching needed
	if (optimizedSource !== node.source) {
		const result = new CTENode(
			node.scope,
			node.cteName,
			node.columns,
			optimizedSource,
			node.materializationHint,
			node.isRecursive
		);

		log('Optimized CTE source without caching');
		return result;
	}

	return null; // No transformation needed
}
