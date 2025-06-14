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

// Re-export for convenience
export { DEFAULT_TUNING };

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
import { ruleCteOptimization } from './rules/cache/rule-cte-optimization.js';
import { ruleMarkPhysical } from './rules/physical/rule-mark-physical.js';
// Phase 3 rules
import { ruleConstantFolding } from './rules/rewrite/rule-constant-folding.js';
import { validatePhysicalTree } from './validation/plan-validator.js';
import { Database } from '../core/database.js';

const log = createLogger('optimizer');

/**
 * The query optimizer transforms logical plan trees into physical plan trees
 */
export class Optimizer {
	private readonly stats: StatsProvider;

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

		// Phase 3 rules - constant folding
		// Register for multiple node types that commonly have expressions
		const constantFoldingNodeTypes = [
			PlanNodeType.Project,    // Projection expressions
			PlanNodeType.Filter,     // Predicate expressions
			PlanNodeType.Window,     // Window function expressions
			PlanNodeType.Aggregate,  // Aggregate expressions
			PlanNodeType.Sort,       // Sort key expressions
			PlanNodeType.Values,     // Literal values in VALUES clauses
			PlanNodeType.Join        // Join condition expressions
		];

		for (const nodeType of constantFoldingNodeTypes) {
			toRegister.push(createRule(
				`constant-folding-${nodeType.toLowerCase()}`,
				nodeType,
				'rewrite',
				ruleConstantFolding,
				10 // Very high priority - should run first to help other rules
			));
		}

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
	optimize(plan: PlanNode, db: Database): PlanNode {
		log('Starting optimization of plan', plan.nodeType);

		// Clear rule tracking from previous runs
		clearVisitedRules();

		// Create optimization context
		const context = createOptContext(this, this.stats, this.tuning, db);

		tracePhaseStart('optimization');
		try {
			const result = this.optimizeNode(plan, context);

			// Phase 3: Validate the physical plan before returning
			if (this.tuning.debug.validatePlan) {
				log('Running plan validation');
				try {
					validatePhysicalTree(result);
					log('Plan validation passed');
				} catch (error) {
					log('Plan validation failed: %s', error);
					throw error;
				}
			}

			return result;
		} finally {
			tracePhaseEnd('optimization');
		}
	}

	optimizeNode(node: PlanNode, context: OptContext): PlanNode {
		traceNodeStart(node);

		// If already physical, just recurse on children
		if (node.physical) {
			const result = this.optimizeChildren(node, context);
			traceNodeEnd(node, result);
			return result;
		}

		// First optimize all children
		const optimizedNode = this.optimizeChildren(node, context);

		// Apply rules
		const rulesApplied = applyRules(optimizedNode, context);

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

	private optimizeChildren(node: PlanNode, context: OptContext): PlanNode {
		// Generic tree walk using withChildren
		const originalChildren = node.getChildren();
		const optimizedChildren = originalChildren.map(child => this.optimizeNode(child, context));

		// Check if any children changed
		const childrenChanged = optimizedChildren.some((child, i) => child !== originalChildren[i]);

		if (!childrenChanged) {
			return node; // No changes
		}

		// Use withChildren to create new node with optimized children
		// withChildren is a required contract - any errors should propagate
		return node.withChildren(optimizedChildren);
	}



	/**
	 * Get the statistics provider
	 */
	getStats(): StatsProvider {
		return this.stats;
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


}
