/**
 * Materialization advisory framework
 * Decides when and how to inject caching based on reference graph analysis
 */

import { createLogger } from '../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { CacheNode, type CacheStrategy } from '../nodes/cache-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';
import { ReferenceGraphBuilder, type RefStats } from './reference-graph.js';

const log = createLogger('optimizer:cache:materialization');

/**
 * Cache recommendation for a specific node
 */
export interface CacheRecommendation {
	/** Whether to inject caching for this node */
	shouldCache: boolean;
	/** Recommended cache strategy */
	strategy: CacheStrategy;
	/** Recommended cache threshold */
	threshold: number;
	/** Reason for the recommendation (for debugging) */
	reason: string;
}

/**
 * Materialization advisory that analyzes plan trees and recommends caching
 */
export class MaterializationAdvisory {
	private referenceBuilder: ReferenceGraphBuilder;

	constructor(private tuning: OptimizerTuning) {
		this.referenceBuilder = new ReferenceGraphBuilder(tuning);
	}

	/**
	 * Analyze a plan tree and return caching recommendations
	 */
	analyzeTree(root: PlanNode): Map<PlanNode, CacheRecommendation> {
		const refGraph = this.referenceBuilder.buildReferenceGraph(root);
		const recommendations = new Map<PlanNode, CacheRecommendation>();

		for (const [node, stats] of refGraph) {
			// Only consider relational nodes for caching
			if (!this.isRelationalNode(node)) {
				continue;
			}

			const recommendation = this.adviseCaching(node, stats);
			recommendations.set(node, recommendation);

			if (recommendation.shouldCache) {
				log('Recommending cache for %s: %s', node.nodeType, recommendation.reason);
			}
		}

		return recommendations;
	}

	/**
	 * Apply caching recommendations to a plan tree
	 */
	applyCaching(root: PlanNode, recommendations: Map<PlanNode, CacheRecommendation>): PlanNode {
		return this.transformNode(root, recommendations);
	}

	/**
	 * Core advisory algorithm
	 */
	private adviseCaching(node: PlanNode, stats: RefStats): CacheRecommendation {
		// Rule 1: Non-deterministic nodes should not be cached
		if (!stats.deterministic) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Non-deterministic node'
			};
		}

		// Rule 2: Nodes that are already cached don't need additional caching
		if (node.nodeType === PlanNodeType.Cache) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Already cached'
			};
		}

		// Rule 3: Single-parent nodes that don't appear in loops typically don't benefit from caching
		if (stats.parentCount <= 1 && !stats.appearsInLoop) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Single parent, not in loop'
			};
		}

		// Rule 4: Multi-parent nodes benefit from caching
		if (stats.parentCount > 1) {
			const strategy = this.selectStrategy(stats.estimatedRows);
			const threshold = this.calculateThreshold(stats.estimatedRows, strategy);

			return {
				shouldCache: true,
				strategy,
				threshold,
				reason: `Multiple parents (${stats.parentCount})`
			};
		}

		// Rule 5: Nodes in loop contexts benefit from caching even with single parent
		if (stats.appearsInLoop) {
			// Check if the estimated size is reasonable for caching
			if (stats.estimatedRows > this.tuning.join.maxRightRowsForCaching) {
				return {
					shouldCache: false,
					strategy: 'memory',
					threshold: 0,
					reason: `In loop but too large (${stats.estimatedRows} rows)`
				};
			}

			const strategy = this.selectStrategy(stats.estimatedRows);
			const threshold = this.calculateThreshold(stats.estimatedRows, strategy);

			return {
				shouldCache: true,
				strategy,
				threshold,
				reason: 'Appears in loop context'
			};
		}

		// Default: no caching
		return {
			shouldCache: false,
			strategy: 'memory',
			threshold: 0,
			reason: 'No caching criteria met'
		};
	}

		/**
	 * Select appropriate cache strategy based on estimated size
	 */
	private selectStrategy(estimatedRows: number): CacheStrategy {
		// Use tuning configuration for strategy selection
		if (this.tuning.cache.spillEnabled && estimatedRows > this.tuning.cache.spillThreshold) {
			return 'spill';
		}

		return 'memory';
	}

	/**
	 * Calculate appropriate cache threshold
	 */
	private calculateThreshold(estimatedRows: number, strategy: CacheStrategy): number {
		const multiplier = this.tuning.join.cacheThresholdMultiplier;
		const maxThreshold = strategy === 'spill' ?
			this.tuning.join.maxCacheThreshold * 2 : // Allow larger thresholds for spill
			this.tuning.join.maxCacheThreshold;

		return Math.min(
			Math.max(estimatedRows * multiplier, 1000), // Minimum threshold
			maxThreshold
		);
	}

	/**
	 * Check if a node is relational (can be cached)
	 */
	private isRelationalNode(node: PlanNode): boolean {
		return 'getAttributes' in node && typeof (node as any).getAttributes === 'function';
	}

	/**
	 * Transform a node tree by applying cache recommendations
	 */
	private transformNode(node: PlanNode, recommendations: Map<PlanNode, CacheRecommendation>): PlanNode {
		// First, recursively transform children
		const transformedNode = this.transformChildren(node, recommendations);

		// Check if this node should be cached
		const recommendation = recommendations.get(node);
		if (recommendation?.shouldCache && this.isRelationalNode(transformedNode)) {
			log('Injecting %s cache for %s (threshold: %d)',
				recommendation.strategy, transformedNode.nodeType, recommendation.threshold);

			return new CacheNode(
				transformedNode.scope,
				transformedNode as RelationalPlanNode,
				recommendation.strategy,
				recommendation.threshold
			);
		}

		return transformedNode;
	}

	/**
	 * Transform children of a node
	 */
	private transformChildren(node: PlanNode, recommendations: Map<PlanNode, CacheRecommendation>): PlanNode {
		// Handle different node types that have children

		// For nodes with relational children, we need to transform them
		if ('getRelations' in node) {
			const relations = (node as any).getRelations();
			const transformedRelations = relations.map((rel: PlanNode) =>
				this.transformNode(rel, recommendations)
			);

			// Check if any relations were transformed
			if (transformedRelations.some((rel: PlanNode, idx: number) => rel !== relations[idx])) {
				// Need to create a new node with transformed relations
				return this.recreateNodeWithNewRelations(node, transformedRelations);
			}
		}

		// If no transformations needed, return original node
		return node;
	}

	/**
	 * Recreate a node with new relational children
	 * This is a simplified version - in practice, would need comprehensive node cloning
	 */
	private recreateNodeWithNewRelations(node: PlanNode, newRelations: RelationalPlanNode[]): PlanNode {
		// This is a simplified implementation
		// In practice, would need to handle all node types properly

		// For now, just return the original node
		// This would need to be expanded to handle all node types
		log('Node recreation not yet implemented for %s', node.nodeType);
		return node;
	}
}
