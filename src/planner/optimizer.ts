import { createLogger } from '../common/logger.js';
import { PlanNode, type RelationalPlanNode, type PhysicalProperties } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { BlockNode } from './nodes/block.js';
import { AggregateNode } from './nodes/aggregate-node.js';
import { StreamAggregateNode } from './nodes/stream-aggregate.js';
import { SortNode } from './nodes/sort.js';
import type { Scope } from './scopes/scope.js';

const log = createLogger('optimizer');

/**
 * Optimization rule that transforms logical nodes to physical nodes
 */
type OptimizationRule = (node: PlanNode, optimizer: Optimizer) => PlanNode | null;

/**
 * The query optimizer transforms logical plan trees into physical plan trees
 */
export class Optimizer {
	private rules: Map<PlanNodeType, OptimizationRule[]> = new Map();

	constructor() {
		this.registerDefaultRules();
	}

	/**
	 * Optimize a plan tree by applying transformation rules
	 */
	optimize(plan: PlanNode): PlanNode {
		log('Starting optimization of plan', plan.nodeType);
		return this.optimizeNode(plan);
	}

	private optimizeNode(node: PlanNode): PlanNode {
		// If already physical, just recurse on children
		if (node.physical) {
			return this.optimizeChildren(node);
		}

		// Try to apply rules for this node type
		const rules = this.rules.get(node.nodeType) || [];
		for (const rule of rules) {
			const result = rule(node, this);
			if (result) {
				log(`Applied rule for ${node.nodeType}, transformed to ${result.nodeType}`);
				// Recursively optimize the result
				return this.optimizeNode(result);
			}
		}

		// No rule applied, optimize children and keep as-is
		return this.optimizeChildren(node);
	}

	private optimizeChildren(node: PlanNode): PlanNode {
		// For simplicity, we'll handle specific node types
		// In a full implementation, this would be more generic

		if (node instanceof BlockNode) {
			const optimizedStatements = node.statements.map(stmt =>
				stmt instanceof PlanNode ? this.optimizeNode(stmt) : stmt
			);
			if (optimizedStatements === node.statements) return node;
			return new BlockNode(node.scope, optimizedStatements, node.parameters);
		}

		if (node instanceof AggregateNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new AggregateNode(node.scope, optimizedSource, node.groupBy, node.aggregates);
		}

		if (node instanceof SortNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new SortNode(node.scope, optimizedSource, node.sortKeys);
		}

		// For other nodes, return as-is for now
		// TODO: Handle all node types generically
		return node;
	}

	/**
	 * Register a transformation rule for a specific node type
	 */
	registerRule(nodeType: PlanNodeType, rule: OptimizationRule): void {
		if (!this.rules.has(nodeType)) {
			this.rules.set(nodeType, []);
		}
		this.rules.get(nodeType)!.push(rule);
	}

	/**
	 * Register the default optimization rules
	 */
	private registerDefaultRules(): void {
		// Rule: Logical Aggregate → Physical StreamAggregate
		this.registerRule(PlanNodeType.Aggregate, (node, optimizer) => {
			if (!(node instanceof AggregateNode)) return null;

			// Optimize the source first
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

			// For now, always use StreamAggregate
			// TODO: Check if source is ordered on groupBy columns
			// TODO: Consider HashAggregate for unordered inputs

			if (node.groupBy.length > 0) {
				// Need to ensure ordering for streaming aggregate
				// For now, always insert a sort
				// TODO: Check if source already provides the required ordering
				const sortKeys = node.groupBy.map(expr => ({
					expression: expr,
					direction: 'asc' as const,
					nulls: undefined
				}));

				const sortNode = new SortNode(node.scope, optimizedSource, sortKeys);
				sortNode.physical = {
					ordering: node.groupBy.map((_, idx) => ({ column: idx, desc: false }))
				};

				return new StreamAggregateNode(
					node.scope,
					sortNode,
					node.groupBy,
					node.aggregates
				);
			} else {
				// No GROUP BY - can stream aggregate without sorting
				return new StreamAggregateNode(
					node.scope,
					optimizedSource,
					node.groupBy,
					node.aggregates
				);
			}
		});

		// Rule: Logical TableScan → Physical SeqScan
		// For now, keep TableScan as-is since it's already physical
		// TODO: Implement this when we have separate logical/physical scan nodes

		// Rule: Keep Sort nodes as physical
		this.registerRule(PlanNodeType.Sort, (node, optimizer) => {
			if (!(node instanceof SortNode)) return null;

			// Sort is already a physical node in our current design
			// Just optimize its source
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return null; // No change

			const newSort = new SortNode(node.scope, optimizedSource, node.sortKeys);
			// Set physical properties
			newSort.physical = {
				ordering: node.sortKeys.map((key, idx) => ({
					column: idx,
					desc: key.direction === 'desc'
				}))
			};
			return newSort;
		});
	}
}
