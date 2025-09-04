import { createLogger } from '../common/logger.js';
import { PlanNode } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { OptimizerTuning, DEFAULT_TUNING } from './optimizer-tuning.js';

// Re-export for convenience
export { DEFAULT_TUNING };

import { applyRules, registerRules, createRule } from './framework/registry.js';
import { tracePhaseStart, tracePhaseEnd, traceNodeStart, traceNodeEnd } from './framework/trace.js';
import { defaultStatsProvider, type StatsProvider } from './stats/index.js';
import { createOptContext, type OptContext } from './framework/context.js';
import type { OptimizerDiagnostics } from './framework/context.js';
import { PassManager, PassId } from './framework/pass.js';
// Phase 2 rules
import { ruleMaterializationAdvisory } from './rules/cache/rule-materialization-advisory.js';
// Phase 1.5 rules
import { ruleSelectAccessPath } from './rules/access/rule-select-access-path.js';
import { ruleGrowRetrieve } from './rules/retrieve/rule-grow-retrieve.js';
import { rulePredicatePushdown } from './rules/predicate/rule-predicate-pushdown.js';
import { ruleJoinKeyInference } from './rules/join/rule-join-key-inference.js';
import { ruleJoinGreedyCommute } from './rules/join/rule-join-greedy-commute.js';
// Predicate pushdown rules
// Core optimization rules
import { ruleAggregateStreaming } from './rules/aggregate/rule-aggregate-streaming.js';
import { ruleQuickPickJoinEnumeration } from './rules/join/rule-quickpick-enumeration.js';
// Constraint rules removed - now handled in builders for correctness
import { ruleCteOptimization } from './rules/cache/rule-cte-optimization.js';
import { ruleMutatingSubqueryCache } from './rules/cache/rule-mutating-subquery-cache.js';
// Phase 3 rules
import { validatePhysicalTree } from './validation/plan-validator.js';
import { Database } from '../core/database.js';
import { performConstantFolding } from './analysis/const-pass.js';
import { createRuntimeExpressionEvaluator } from './analysis/const-evaluator.js';

const log = createLogger('optimizer');

/**
 * The query optimizer transforms logical plan trees into physical plan trees
 */
export class Optimizer {
	private readonly stats: StatsProvider;
	private readonly passManager: PassManager;
  private lastDiagnostics: OptimizerDiagnostics | null = null;

	constructor(
		public readonly tuning: OptimizerTuning = DEFAULT_TUNING,
		stats?: StatsProvider
	) {
		this.stats = stats ?? defaultStatsProvider;
		this.passManager = new PassManager();

		// Register rules to their appropriate passes only (no legacy globals)
		this.registerRulesToPasses();
	}

	private static globalRulesRegistered = false;

	/**
	 * Legacy method removed; keep empty to avoid duplicate registrations
	 */

	/**
	 * Register rules with their appropriate passes
	 */
	private registerRulesToPasses(): void {
		// Structural pass rules (top-down) - for operations that need parent context
		// Register grow-retrieve for ALL relational node types
		// The rule itself will determine if growth is possible
		const relationalNodeTypes = [
			PlanNodeType.Filter,
			PlanNodeType.Project,
			PlanNodeType.Sort,
			PlanNodeType.LimitOffset,
			PlanNodeType.Aggregate,
			PlanNodeType.Distinct,
			PlanNodeType.Join,
			PlanNodeType.Window,
			// Add any other relational node types as needed
		];

		for (const nodeType of relationalNodeTypes) {
			this.passManager.addRuleToPass(PassId.Structural, {
				id: `grow-retrieve-${nodeType}`,
				nodeType,
				phase: 'rewrite',
				fn: ruleGrowRetrieve,
				priority: 10
			});
		}

		// Join key inference (structural/characteristic)
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-key-inference',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleJoinKeyInference,
			priority: 15
		});

		// Greedy join commute: place smaller input on the left to improve nested-loop-like costs
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-greedy-commute',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleJoinGreedyCommute,
			priority: 16
		});

		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'predicate-pushdown',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: rulePredicatePushdown,
			priority: 20
		});

		// Physical pass rules (bottom-up) - for logical to physical transformations
		this.passManager.addRuleToPass(PassId.Physical, {
			id: 'select-access-path',
			nodeType: PlanNodeType.Retrieve,
			phase: 'impl',
			fn: ruleSelectAccessPath,
			priority: 10
		});

		// QuickPick join enumeration (optional via tuning)
		this.passManager.addRuleToPass(PassId.Physical, {
			id: 'quickpick-join-enumeration',
			nodeType: PlanNodeType.Join,
			phase: 'impl',
			fn: ruleQuickPickJoinEnumeration,
			priority: 5
		});

		this.passManager.addRuleToPass(PassId.Physical, {
			id: 'aggregate-streaming',
			nodeType: PlanNodeType.Aggregate,
			phase: 'impl',
			fn: ruleAggregateStreaming,
			priority: 20
		});

		// Post-optimization pass rules (bottom-up) - for cleanup and caching
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'mutating-subquery-cache',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleMutatingSubqueryCache,
			priority: 10
		});

		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'cte-optimization',
			nodeType: PlanNodeType.CTE,
			phase: 'rewrite',
			fn: ruleCteOptimization,
			priority: 20
		});

		// Register materialization advisory for multiple node types
		const nodeTypesForMaterialization = [
			PlanNodeType.Block,
			PlanNodeType.ScalarSubquery,
			PlanNodeType.Exists,
			PlanNodeType.In,
			PlanNodeType.Insert,
			PlanNodeType.Update,
			PlanNodeType.Delete,
			PlanNodeType.CTE,
			PlanNodeType.RecursiveCTE,
			PlanNodeType.Returning,
			PlanNodeType.ScalarFunctionCall,
			PlanNodeType.CaseExpr,
		];

		for (const nodeType of nodeTypesForMaterialization) {
			this.passManager.addRuleToPass(PassId.PostOptimization, {
				id: `materialization-advisory-${nodeType}`,
				nodeType,
				phase: 'rewrite',
				fn: ruleMaterializationAdvisory,
				priority: 30
			});
		}

		log('Registered rules to optimization passes');
	}

	/**
	 * Optimize a plan tree by applying transformation rules
	 */
	optimize(plan: PlanNode, db: Database): PlanNode {
		log('Starting optimization of plan', plan.nodeType);

		// Create optimization context
		const context = createOptContext(this, this.stats, this.tuning, db);

		tracePhaseStart('optimization');
		try {
			// Execute all optimization passes
			const optimizedPlan = this.passManager.execute(plan, context);

			// Capture diagnostics snapshot for external consumers
			this.lastDiagnostics = { ...context.diagnostics };

			// Final validation (if enabled)
			if (this.tuning.debug.validatePlan) {
				log('Running plan validation');
				try {
					validatePhysicalTree(optimizedPlan);
					log('Plan validation passed');
				} catch (error) {
					log('Plan validation failed: %s', error);
					throw error;
				}
			}

			return optimizedPlan;
		} finally {
			tracePhaseEnd('optimization');
		}
	}

	/**
	 * Run only non-physical passes to obtain a structurally rewritten logical plan
	 * suitable for pre-physical analysis (e.g., row-specific classification).
	 */
	optimizeForAnalysis(plan: PlanNode, db: Database): PlanNode {
		log('Starting pre-physical analysis optimization of plan', plan.nodeType);

		const context = createOptContext(this, this.stats, this.tuning, db);
		tracePhaseStart('pre-physical-analysis');
		try {
			// Execute only structural pass(es) and constant folding
			const folded = this.performConstantFolding(plan, context);
			const structuralOnly = this.passManager.executeUpTo(folded, context, PassId.Structural);
			this.lastDiagnostics = { ...context.diagnostics };
			return structuralOnly;
		} finally {
			tracePhaseEnd('pre-physical-analysis');
		}
	}

	/**
	 * Perform single-pass constant folding over the entire plan tree
	 */
	private performConstantFolding(plan: PlanNode, context: OptContext): PlanNode {
		// Create runtime expression evaluator
		const evaluator = createRuntimeExpressionEvaluator(context.db);

		// Perform single-pass constant folding
		const result = performConstantFolding(plan, evaluator);

		log('Constant folding completed');
		return result;
	}

	optimizeNode(node: PlanNode, context: OptContext): PlanNode {
		traceNodeStart(node);

		// Check if we've already optimized this exact node instance
		const cached = context.optimizedNodes.get(node.id);
		if (cached) {
			log('Reusing optimized version of shared node %s (%s)', node.id, node.nodeType);
			traceNodeEnd(node, cached);
			return cached;
		}

		// Note: We removed the broken `if (node.physical)` check here
		// The `physical` property is always truthy (it returns a PhysicalProperties object)
		// Physical vs logical distinction should be handled by the rules themselves

		// First optimize all children
		const optimizedNode = this.optimizeChildren(node, context);

		// Apply rules
		const rulesApplied = applyRules(optimizedNode, context);

		if (rulesApplied !== optimizedNode) {
			// Rules transformed the node
			log(`Rules applied to ${optimizedNode.nodeType}, transformed to ${rulesApplied.nodeType}`);
			traceNodeEnd(node, rulesApplied);

			// Cache the final result
			context.optimizedNodes.set(node.id, rulesApplied);
			return rulesApplied;
		}

		// No rule applied - assume node is physical
		traceNodeEnd(node, optimizedNode);

		// Cache the result even if no rules applied
		context.optimizedNodes.set(node.id, optimizedNode);
		return optimizedNode;
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

	/** Get diagnostics from the last optimization run */
	getLastDiagnostics(): OptimizerDiagnostics | null {
		return this.lastDiagnostics;
	}
}
