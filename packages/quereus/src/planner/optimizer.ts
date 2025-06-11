import { createLogger } from '../common/logger.js';
import { PlanNode, type RelationalPlanNode, type PhysicalProperties } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { BlockNode } from './nodes/block.js';
import { AggregateNode } from './nodes/aggregate-node.js';
import { SortNode } from './nodes/sort.js';
import { FilterNode } from './nodes/filter.js';
import { DistinctNode } from './nodes/distinct-node.js';
import { SetOperationNode } from './nodes/set-operation-node.js';
import { ProjectNode } from './nodes/project-node.js';
import { LimitOffsetNode } from './nodes/limit-offset.js';
import { WindowNode } from './nodes/window-node.js';
import { InsertNode } from './nodes/insert-node.js';
import { UpdateNode } from './nodes/update-node.js';
import { UpdateExecutorNode } from './nodes/update-executor-node.js';
import { DeleteNode } from './nodes/delete-node.js';
import { ConstraintCheckNode } from './nodes/constraint-check-node.js';
import { JoinNode } from './nodes/join-node.js';
import { CacheNode } from './nodes/cache-node.js';
import { OptimizerTuning, DEFAULT_TUNING } from './optimizer-tuning.js';

import { ReturningNode } from './nodes/returning-node.js';
import { SinkNode } from './nodes/sink-node.js';
import { quereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { applyRules, clearVisitedRules, registerRules, createRule } from './framework/registry.js';
import { tracePhaseStart, tracePhaseEnd, traceNodeStart, traceNodeEnd } from './framework/trace.js';
import { defaultStatsProvider, type StatsProvider } from './stats/index.js';
import { createOptContext, type OptContext } from './framework/context.js';
// Phase 2 rules
import { ruleMaterializationAdvisory } from './rules/cache/rule-materialization-advisory.js';
// Phase 1.5 rules
import { ruleSelectAccessPath } from './rules/access/rule-select-access-path.js';
// Core optimization rules
import { ruleAggregateStreaming } from './rules/aggregate/rule-aggregate-streaming.js';
// Constraint rules removed - now handled in builders for correctness
import { ruleSortOptimization } from './rules/physical/rule-sort-optimization.js';
import { ruleCteOptimization } from './rules/cache/rule-cte-optimization.js';
import { ruleProjectOptimization } from './rules/physical/rule-project-optimization.js';
import { ruleFilterOptimization } from './rules/physical/rule-filter-optimization.js';
import { ruleMarkPhysical } from './rules/physical/rule-mark-physical.js';

const log = createLogger('optimizer');

/**
 * The query optimizer transforms logical plan trees into physical plan trees
 */
export class Optimizer {
	private readonly stats: StatsProvider;
	private context?: OptContext;

	constructor(
		public readonly tuning: OptimizerTuning = DEFAULT_TUNING,
		stats?: StatsProvider
	) {
		this.stats = stats ?? defaultStatsProvider;

		// Ensure global framework rules are registered once
		Optimizer.ensureGlobalRulesRegistered();
	}

	private static globalRulesRegistered = false;

	/**
	 * Ensure global framework rules are registered only once
	 */
	private static ensureGlobalRulesRegistered(): void {
		if (Optimizer.globalRulesRegistered) {
			return;
		}
		Optimizer.globalRulesRegistered = true;

		const toRegister = [];

		// Core optimization rules (converted from old system)
		toRegister.push(createRule(
			'aggregate-streaming',
			PlanNodeType.Aggregate,
			'impl',
			ruleAggregateStreaming,
			40 // High priority - fundamental logical→physical transformation
		));

		// Constraint rules removed - now handled directly in builders for correctness

		toRegister.push(createRule(
			'sort-optimization',
			PlanNodeType.Sort,
			'impl',
			ruleSortOptimization,
			60 // Medium priority - optimization only
		));

		toRegister.push(createRule(
			'cte-optimization',
			PlanNodeType.CTE,
			'impl',
			ruleCteOptimization,
			70 // Lower priority - caching optimization
		));

		// toRegister.push(createRule(
		// 	'project-optimization',
		// 	PlanNodeType.Project,
		// 	'impl',
		// 	ruleProjectOptimization,
		// 	50 // Medium priority - basic optimization
		// ));

		// toRegister.push(createRule(
		// 	'filter-optimization',
		// 	PlanNodeType.Filter,
		// 	'impl',
		// 	ruleFilterOptimization,
		// 	50 // Medium priority - basic optimization
		// ));

		// Phase 1.5 rules
		toRegister.push(createRule(
			'select-access-path',
			PlanNodeType.TableScan,
			'impl',
			ruleSelectAccessPath,
			30 // High priority - fundamental access path selection
		));

		// Phase 2 rules
		toRegister.push(createRule(
			'materialization-advisory',
			PlanNodeType.Block, // Apply to root-level nodes
			'rewrite',
			ruleMaterializationAdvisory,
			90 // Low priority - run last for global analysis
		));

		// Fallback rule - must run last with lowest priority
		// We need to register this for multiple node types that might need fallback handling
		const fallbackNodeTypes = [
			PlanNodeType.TableScan, PlanNodeType.Values, PlanNodeType.TableFunctionCall,
			PlanNodeType.Join, PlanNodeType.NestedLoopJoin, PlanNodeType.SingleRow,
			PlanNodeType.SetOperation, PlanNodeType.Distinct, PlanNodeType.LimitOffset,
			PlanNodeType.Window, PlanNodeType.Block, PlanNodeType.CTEReference,
			PlanNodeType.Cache, PlanNodeType.Sequencing, PlanNodeType.UpdateExecutor
		];

		for (const nodeType of fallbackNodeTypes) {
			toRegister.push(createRule(
				`mark-physical-${nodeType.toLowerCase()}`,
				nodeType,
				'impl',
				ruleMarkPhysical,
				100 // Lowest priority - absolute fallback
			));
		}

		// Register all rules at once
		registerRules(toRegister);
	}

	/**
	 * Optimize a plan tree by applying transformation rules
	 */
	optimize(plan: PlanNode): PlanNode {
		log('Starting optimization of plan', plan.nodeType);

		// Clear rule tracking from previous runs
		clearVisitedRules();

		// Create optimization context
		this.context = createOptContext(this, this.stats, this.tuning);

		tracePhaseStart('optimization');
		try {
			const result = this.optimizeNode(plan);
			return result;
		} finally {
			tracePhaseEnd('optimization');
			this.context = undefined;
		}
	}

	optimizeNode(node: PlanNode): PlanNode {
		traceNodeStart(node);

		// If already physical, just recurse on children
		if (node.physical) {
			const result = this.optimizeChildren(node);
			traceNodeEnd(node, result);
			return result;
		}

		// First optimize all children
		const optimizedNode = this.optimizeChildren(node);

		// Apply rules
		const rulesApplied = applyRules(optimizedNode, this);

		if (rulesApplied !== optimizedNode) {
			// Rules transformed the node
			log(`Rules applied to ${optimizedNode.nodeType}, transformed to ${rulesApplied.nodeType}`);
			this.markPhysical(rulesApplied);
			traceNodeEnd(node, rulesApplied);
			return rulesApplied;
		}

		// No rule applied - if node supports direct physical conversion, do it
		if (this.canBePhysical(optimizedNode)) {
			this.markPhysical(optimizedNode);
			traceNodeEnd(node, optimizedNode);
			return optimizedNode;
		} else {
			log('Failed to make node %s physical after optimization', optimizedNode.nodeType);
			quereusError(
				`No rule to make ${optimizedNode.nodeType} physical`,
				StatusCode.INTERNAL
			);
		}
	}

	private optimizeChildren(node: PlanNode): PlanNode {
		// Generic tree walk using withChildren
		const originalChildren = node.getChildren();
		const optimizedChildren = originalChildren.map(child => this.optimizeNode(child));

		// Check if any children changed
		const childrenChanged = optimizedChildren.some((child, i) => child !== originalChildren[i]);

		if (!childrenChanged) {
			return node; // No changes
		}

		// Use withChildren to create new node with optimized children
		try {
			return node.withChildren(optimizedChildren);
		} catch (error) {
			// Fallback for nodes that don't have withChildren implemented yet
			log('withChildren not implemented for %s, using manual approach: %s', node.nodeType, error);
			return this.optimizeChildrenManual(node);
		}
	}

	/**
	 * Manual child optimization for nodes that don't have withChildren implemented yet
	 * This is a temporary fallback during the migration
	 */
	private optimizeChildrenManual(node: PlanNode): PlanNode {
		// Handle specific node types that can contain children
		// This ensures we recurse into all common plan nodes

		if (node instanceof JoinNode) {
			// Use specialized join optimization that may inject caching
			return this.optimizeJoinCaching(node as JoinNode);
		}

		if (node instanceof WindowNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new WindowNode(node.scope, optimizedSource, node.windowSpec, node.functions, node.partitionExpressions, node.orderByExpressions, node.functionArguments);
		}

		if (node instanceof InsertNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new InsertNode(node.scope, node.table, node.targetColumns, optimizedSource, node.onConflict, node.newRowDescriptor);
		}

		if (node instanceof UpdateNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new UpdateNode(node.scope, node.table, node.assignments, optimizedSource, node.onConflict, node.oldRowDescriptor, node.newRowDescriptor);
		}

		if (node instanceof UpdateExecutorNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new UpdateExecutorNode(node.scope, optimizedSource, node.table);
		}

		if (node instanceof DeleteNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new DeleteNode(node.scope, node.table, optimizedSource, node.oldRowDescriptor);
		}

		if (node instanceof ConstraintCheckNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new ConstraintCheckNode(node.scope, optimizedSource, node.table, node.operation, node.oldRowDescriptor, node.newRowDescriptor);
		}

		if (node instanceof ReturningNode) {
			const optimizedExecutor = this.optimizeNode(node.executor) as RelationalPlanNode;
			if (optimizedExecutor !== node.executor) {
				return new ReturningNode(
					node.scope,
					optimizedExecutor,
					node.projections
				);
			}
			return node;
		}

		if (node instanceof SinkNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new SinkNode(node.scope, optimizedSource, node.operation);
		}

		// For other nodes, return as-is
		// This is safe for leaf nodes and nodes we don't need to optimize children for
		return node;
	}

	/**
	 * Get the statistics provider
	 */
	getStats(): StatsProvider {
		return this.stats;
	}

	/**
	 * Get the current optimization context
	 */
	getContext(): OptContext | undefined {
		return this.context;
	}

	// Constraint-related methods removed - constraints now handled in builders

	/**
	 * Mark a node as physical and compute its properties
	 */
	private markPhysical(node: PlanNode): void {
		if (node.physical) return; // Already physical

		// Collect physical properties from children (both scalar and relational)
		const childrenPhysical: PhysicalProperties[] = [];

		// Add properties from scalar children
		for (const child of node.getChildren()) {
			if (child instanceof PlanNode && child.physical) {
				childrenPhysical.push(child.physical);
			}
		}

		// Add properties from relational children
		for (const relation of node.getRelations()) {
			if (relation.physical) {
				childrenPhysical.push(relation.physical);
			}
		}

		// Let the node compute its own physical properties if it can
		let computedProperties: PhysicalProperties | undefined;
		if (node.getPhysical) {
			computedProperties = node.getPhysical(childrenPhysical);
		}

		// Set default physical properties with computed properties as override
		PlanNode.setDefaultPhysical(node, computedProperties);

		// Optimizer can override/adjust properties here
		// For example, propagate constant flag up the tree
		if (childrenPhysical.length > 0 && childrenPhysical.every(p => p.constant)) {
			node.physical!.constant = true;
		}
	}

	/**
	 * Check if a node type can be directly marked as physical without transformation
	 */
	private canBePhysical(node: PlanNode): boolean {
		// Types that need logical-to-physical transformation
		const needsTransformation = new Set([
			PlanNodeType.Aggregate,  // → StreamAggregate/HashAggregate
			// Insert/Update/Delete might need ConstraintCheck wrapping (handled by rules)
			// Most other types are directly physical
		]);

		return !needsTransformation.has(node.nodeType);
	}

	private optimizeJoinCaching(node: JoinNode): RelationalPlanNode {
		// For nested loop joins, caching the right side can provide significant benefits
		// when the right side will be scanned multiple times (once per left row)

		const leftSize = node.left.estimatedRows ?? this.tuning.defaultRowEstimate;
		const rightSize = node.right.estimatedRows ?? this.tuning.defaultRowEstimate;

		// Heuristic: For nested loop joins, we almost always want to cache the right side
		// unless it's obviously too large or already cached
		const shouldCacheRight = node.right.nodeType !== PlanNodeType.Cache &&
								// Always cache for small/medium datasets or when estimates are missing
								(leftSize === 0 || leftSize > this.tuning.join.minLeftRowsForCaching ||
								 rightSize === 0 || rightSize < this.tuning.join.maxRightRowsForCaching);

		let optimizedLeft = this.optimizeNode(node.left) as RelationalPlanNode;
		let optimizedRight = this.optimizeNode(node.right) as RelationalPlanNode;

		if (shouldCacheRight) {
			log('Adding cache to right side of join (left rows: %d, right rows: %d)',
				leftSize, rightSize);
			// Inject cache with appropriate threshold
			const cacheThreshold = rightSize > 0 ?
				Math.min(rightSize * this.tuning.join.cacheThresholdMultiplier, this.tuning.join.maxCacheThreshold) :
				this.tuning.join.maxCacheThreshold;
			optimizedRight = new CacheNode(
				optimizedRight.scope,
				optimizedRight,
				'memory',
				cacheThreshold
			);
		}

		// Use withChildren to rebuild the join with optimized children
		const newChildren = node.condition ?
			[optimizedLeft, optimizedRight, node.condition] :
			[optimizedLeft, optimizedRight];

		if (optimizedLeft !== node.left || optimizedRight !== node.right) {
			try {
				return node.withChildren(newChildren) as RelationalPlanNode;
			} catch (error) {
				// Fallback to manual construction
				log('withChildren failed for JoinNode, using manual construction: %s', error);
				return new JoinNode(
					node.scope,
					optimizedLeft,
					optimizedRight,
					node.joinType,
					node.condition,
					node.usingColumns
				);
			}
		}

		return node;
	}
}
