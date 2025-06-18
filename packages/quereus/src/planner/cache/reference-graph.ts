/**
 * Reference graph builder for materialization advisory
 * Analyzes plan tree to identify nodes that would benefit from caching
 */

import { createLogger } from '../../common/logger.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { JoinNode } from '../nodes/join-node.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';

const log = createLogger('optimizer:cache:reference-graph');

/**
 * Statistics about how a node is referenced in the plan tree
 */
export interface RefStats {
	/** Number of parent nodes referencing this node */
	parentCount: number;
	/** Whether this node appears on the inner side of a nested loop or correlated subquery */
	appearsInLoop: boolean;
	/** Estimated number of rows this node produces */
	estimatedRows: number;
	/** Whether this node is deterministic (same inputs produce same outputs) */
	deterministic: boolean;
}

/**
 * Builds a reference graph for materialization decisions
 */
export class ReferenceGraphBuilder {
	private refMap = new Map<PlanNode, RefStats>();
	private visited = new Set<PlanNode>();

	constructor(private tuning: OptimizerTuning) {}

	/**
	 * Build reference statistics for all nodes in the plan tree
	 */
	buildReferenceGraph(root: PlanNode): Map<PlanNode, RefStats> {
		this.refMap.clear();
		this.visited.clear();

		// First pass: count parent references
		this.countReferences(root, false);

		// Second pass: identify loop contexts
		this.identifyLoopContexts(root, false);

		log('Built reference graph with %d nodes', this.refMap.size);
		return new Map(this.refMap);
	}

	/**
	 * First pass: count how many parents reference each node
	 */
	private countReferences(node: PlanNode, inLoop: boolean): void {
		if (this.visited.has(node)) {
			// Node seen again - increment parent count
			const stats = this.refMap.get(node);
			if (stats) {
				stats.parentCount++;
			}
			return;
		}

		this.visited.add(node);

		// Initialize stats for this node
		const stats: RefStats = {
			parentCount: 1, // First time seeing this node
			appearsInLoop: inLoop,
			estimatedRows: this.getEstimatedRows(node),
			deterministic: this.isDeterministic(node)
		};

		this.refMap.set(node, stats);

		// Recurse to children
		this.visitChildren(node, (child) => {
			this.countReferences(child, inLoop);
		});
	}

	/**
	 * Second pass: identify nodes that appear in loop contexts
	 */
	private identifyLoopContexts(node: PlanNode, inLoop: boolean): void {
		const stats = this.refMap.get(node);
		if (!stats) return;

		// Update loop status if we're now in a loop context
		if (inLoop && !stats.appearsInLoop) {
			stats.appearsInLoop = true;
			log('Node %s marked as appearing in loop', node.nodeType);
		}

		// Determine if children are in loop context
		if (node instanceof JoinNode && node.joinType === 'inner') {
			// Right side of nested loop join is in loop context
			const [left, right] = node.getRelations();
			this.identifyLoopContexts(left, inLoop);
			this.identifyLoopContexts(right, true); // Right side is in loop
		} else {
			// Recurse to all children with current loop status
			this.visitChildren(node, (child) => {
				this.identifyLoopContexts(child, inLoop);
			});
		}
	}

	/**
	 * Visit all children of a node
	 */
	private visitChildren(node: PlanNode, visitor: (child: PlanNode) => void): void {
		// Visit scalar expression children
		for (const child of node.getChildren()) {
			visitor(child);
		}

		// Visit relational children
		if ('getRelations' in node) {
			for (const relation of (node as any).getRelations()) {
				visitor(relation);
			}
		}
	}

	/**
	 * Get estimated row count for a node
	 */
	private getEstimatedRows(node: PlanNode): number {
		if ('estimatedRows' in node && typeof node.estimatedRows === 'number') {
			return node.estimatedRows;
		}
		if (node.physical?.estimatedRows) {
			return node.physical.estimatedRows;
		}
		return this.tuning.defaultRowEstimate;
	}

	/**
	 * Determine if a node is deterministic
	 */
	private isDeterministic(node: PlanNode): boolean {
		// Check physical properties first
		if (node.physical?.deterministic !== undefined) {
			return node.physical.deterministic;
		}

		// Node-type specific deterministic analysis
		switch (node.nodeType) {
			case PlanNodeType.TableScan:
			case PlanNodeType.Values:
			case PlanNodeType.Project:
			case PlanNodeType.Filter:
			case PlanNodeType.Sort:
			case PlanNodeType.Aggregate:
			case PlanNodeType.StreamAggregate:
				return true;

			case PlanNodeType.TableFunctionCall:
				// Would need to check if the table function is deterministic
				// For now, assume non-deterministic to be safe
				return false;

			default:
				// Conservative default - assume deterministic unless proven otherwise
				return true;
		}
	}
}
