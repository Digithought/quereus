import { createLogger } from '../common/logger.js';
import { PlanNode } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { OptimizerTuning, DEFAULT_TUNING } from './optimizer-tuning.js';

// Re-export for convenience
export { DEFAULT_TUNING };

import { applyRules } from './framework/registry.js';
import { tracePhaseStart, tracePhaseEnd, traceNodeStart, traceNodeEnd } from './framework/trace.js';
import { type StatsProvider } from './stats/index.js';
import { CatalogStatsProvider } from './stats/catalog-stats.js';
import { createOptContext, type OptContext } from './framework/context.js';
import type { OptimizerDiagnostics } from './framework/context.js';
import { PassManager, PassId } from './framework/pass.js';
// Phase 2 rules
import { ruleMaterializationAdvisory } from './rules/cache/rule-materialization-advisory.js';
// Phase 1.5 rules
import { ruleSelectAccessPath } from './rules/access/rule-select-access-path.js';
import { ruleMonotonicLimitPushdown } from './rules/access/rule-monotonic-limit-pushdown.js';
import { ruleMonotonicRangeAccess } from './rules/access/rule-monotonic-range-access.js';
import { ruleAsofStrategySelect } from './rules/access/rule-asof-strategy-select.js';
import { ruleGrowRetrieve } from './rules/retrieve/rule-grow-retrieve.js';
import { rulePredicatePushdown } from './rules/predicate/rule-predicate-pushdown.js';
import { ruleAggregatePredicatePushdown } from './rules/predicate/rule-aggregate-predicate-pushdown.js';
import { ruleFilterMerge } from './rules/predicate/rule-filter-merge.js';
import { rulePredicateInferenceEquivalence } from './rules/predicate/rule-predicate-inference-equivalence.js';
import { ruleJoinKeyInference } from './rules/join/rule-join-key-inference.js';
import { ruleJoinGreedyCommute } from './rules/join/rule-join-greedy-commute.js';
import { ruleJoinElimination, ruleJoinEliminationUnderAggregate } from './rules/join/rule-join-elimination.js';
// Predicate pushdown rules
// Core optimization rules
import { ruleAggregatePhysical } from './rules/aggregate/rule-aggregate-streaming.js';
import { ruleGroupByFdSimplification } from './rules/aggregate/rule-groupby-fd-simplification.js';
import { ruleOrderByFdPruning } from './rules/sort/rule-orderby-fd-pruning.js';
import { ruleQuickPickJoinEnumeration } from './rules/join/rule-quickpick-enumeration.js';
import { ruleJoinPhysicalSelection } from './rules/join/rule-join-physical-selection.js';
import { ruleMonotonicMergeJoin } from './rules/join/rule-monotonic-merge-join.js';
import { ruleLateralTop1Asof } from './rules/join/rule-lateral-top1-asof.js';
import { ruleMonotonicWindow } from './rules/window/rule-monotonic-window.js';
// Constraint rules removed - now handled in builders for correctness
import { ruleCteOptimization } from './rules/cache/rule-cte-optimization.js';
import { ruleMutatingSubqueryCache } from './rules/cache/rule-mutating-subquery-cache.js';
import { ruleInSubqueryCache } from './rules/cache/rule-in-subquery-cache.js';
import { ruleSubqueryDecorrelation } from './rules/subquery/rule-subquery-decorrelation.js';
import { ruleAntiJoinFkEmpty } from './rules/subquery/rule-anti-join-fk-empty.js';
import { ruleSemiJoinFkTrivial } from './rules/subquery/rule-semi-join-fk-trivial.js';
import {
	ruleFilterFoldEmpty,
	ruleProjectFoldEmpty,
	ruleSortFoldEmpty,
	ruleLimitOffsetFoldEmpty,
	ruleDistinctFoldEmpty,
	ruleJoinFoldEmpty,
} from './rules/predicate/rule-empty-relation-folding.js';
import { ruleFilterContradiction } from './rules/predicate/rule-filter-contradiction.js';
import { ruleDistinctElimination } from './rules/distinct/rule-distinct-elimination.js';
import { ruleProjectionPruning } from './rules/retrieve/rule-projection-pruning.js';
import { ruleScalarCSE } from './rules/cache/rule-scalar-cse.js';
// Phase 3 rules
import { validatePhysicalTree } from './validation/plan-validator.js';
import { Database } from '../core/database.js';

const log = createLogger('optimizer');

/**
 * The query optimizer transforms logical plan trees into physical plan trees
 */
export class Optimizer {
	private readonly stats: StatsProvider;
	private readonly passManager: PassManager;
	private lastDiagnostics: OptimizerDiagnostics | null = null;
	public tuning: OptimizerTuning;

	constructor(
		tuning: OptimizerTuning = DEFAULT_TUNING,
		stats?: StatsProvider
	) {
		this.stats = stats ?? new CatalogStatsProvider();
		this.passManager = new PassManager();
		this.tuning = tuning;

		// Register rules to their appropriate passes only (no legacy globals)
		this.registerRulesToPasses();
	}

	updateTuning(tuning: OptimizerTuning): void {
		this.tuning = tuning;
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

		// DISTINCT elimination: remove redundant DISTINCT when source already has unique keys
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'distinct-elimination',
			nodeType: PlanNodeType.Distinct,
			phase: 'rewrite',
			fn: ruleDistinctElimination,
			priority: 18
		});

		// Projection pruning: remove unused inner projections in Project-on-Project
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'projection-pruning',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleProjectionPruning,
			priority: 19
		});

		// Aggregate-aware predicate pushdown: splits a Filter above an aggregate so
		// conjuncts on GROUP-BY-determined columns land below the aggregate. Runs
		// before the cross-node predicate pushdown (priority 20) so anything we
		// push below the aggregate can propagate further via that rule.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'aggregate-predicate-pushdown',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleAggregatePredicatePushdown,
			priority: 19
		});

		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'predicate-pushdown',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: rulePredicatePushdown,
			priority: 20
		});

		// Filter merge: combine adjacent Filter nodes into one AND-combined Filter
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'filter-merge',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleFilterMerge,
			priority: 21
		});

		// Scalar CSE: deduplicate common scalar expressions across Project + Filter + Sort chains
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'scalar-cse',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleScalarCSE,
			priority: 22
		});

		// EC-driven predicate inference: materialize inferred equality predicates
		// from the cross of predicate-derived constant bindings and the source's
		// equivalence classes. Runs after predicate-pushdown (priority 20) and
		// filter-merge (priority 21) so the predicate is already consolidated and
		// pushdown won't immediately reabsorb the inferred conjuncts on this
		// iteration; the Structural pass's fixed-point loop then re-runs pushdown
		// on subsequent iterations so the new conjuncts can be carried to
		// branch-level Retrieve pipelines.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'predicate-inference-equivalence',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: rulePredicateInferenceEquivalence,
			priority: 22
		});

		// GROUP BY FD simplification: drop GROUP BY columns determined by other
		// GROUP BY columns under the aggregate's output FDs + ECs. Picker MIN()
		// aggregates re-emit the dropped columns so output attribute IDs survive.
		// Runs after aggregate-predicate-pushdown (priority 19) so filter-derived
		// ECs are already on the aggregate's source, and before
		// ruleAggregatePhysical (Physical pass) so the smaller GROUP BY feeds
		// the stream/hash decision.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'groupby-fd-simplification',
			nodeType: PlanNodeType.Aggregate,
			phase: 'rewrite',
			fn: ruleGroupByFdSimplification,
			priority: 23
		});

		// Join elimination (FK→PK): drop LEFT/INNER joins whose non-preserved side
		// is never referenced above the join and is at-most-one-matching per a
		// declared FK→PK relationship. Runs after predicate-pushdown (priority 20)
		// so any pushed-up filter that *uses* the eliminable side has had a chance
		// to land below the join (and thereby protect itself from elimination).
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-elimination',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleJoinElimination,
			priority: 24
		});

		// Subquery decorrelation: transform correlated EXISTS/IN into semi/anti joins
		// Runs after predicate pushdown (priority 25 > 20) so inner predicates are already pushed
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'subquery-decorrelation',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleSubqueryDecorrelation,
			priority: 25
		});

		// IND-driven existence folding (priority 26 — runs after decorrelation has
		// materialized EXISTS / NOT EXISTS as semi/anti joins):
		//   - Anti-join over a covering non-null FK → Filter(L, false)
		//   - Semi-join over a covering FK → drop join (or Filter L on IS NOT NULL
		//     when the FK is nullable)
		// Both rules read `lookupCoveringFK` from `util/ind-utils.ts`.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'anti-join-fk-empty',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleAntiJoinFkEmpty,
			priority: 26
		});

		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'semi-join-fk-trivial',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleSemiJoinFkTrivial,
			priority: 26
		});

		// Aggregate variant of join-elimination: when an Aggregate sits over an
		// FK-covered inner join and only references the FK side (or `count(*)`),
		// drop the join. Shares chain-walking + FK-PK alignment with
		// ruleJoinElimination via the same module.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-elimination-aggregate',
			nodeType: PlanNodeType.Aggregate,
			phase: 'rewrite',
			fn: ruleJoinEliminationUnderAggregate,
			priority: 26
		});

		// ORDER BY FD pruning: drop trailing ORDER BY keys functionally determined
		// by the leading bare-column keys (under the source's FDs + ECs). Reduces
		// multi-key sorts to single-key sorts when a leading key (e.g. a primary
		// key) determines the rest, which in turn lets `monotonic-limit-pushdown`
		// (PostOptimization priority 8) fire. Structural runs before
		// PostOptimization, so the ordering is automatic. Priority 26 — independent
		// of `subquery-decorrelation` (25); the relative ordering across these
		// Structural priorities is not load-bearing for this rule.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'orderby-fd-pruning',
			nodeType: PlanNodeType.Sort,
			phase: 'rewrite',
			fn: ruleOrderByFdPruning,
			priority: 26
		});

		// Predicate-contradiction folding (priority 27 — after IND rules at 26):
		// detect when (filter predicate ∧ source domainConstraints ∧ literal
		// constantBindings) is provably unsatisfiable, and emit EmptyRelationNode
		// carrying the Filter's own schema. Runs alongside the empty-relation
		// folding rules so its output cascades up the same pass.
		//
		// Inner-join `on`-clause contradiction is intentionally NOT registered
		// here. The filter rule already covers WHERE clauses pushed onto the
		// lowest Filter by `predicate-pushdown`; the join-on variant is tracked
		// as follow-up work — it requires deciding how to preserve the join's
		// post-rewrite output schema for parent operators that reference the
		// right side's attribute IDs.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'filter-contradiction',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleFilterContradiction,
			priority: 27,
		});

		// Empty-relation folding (priority 27 — after IND rules at 26): recognize
		// provably-empty subtrees (Filter on lit-false, or any host with an
		// EmptyRelation source under appropriate join semantics) and replace them
		// with EmptyRelationNode carrying the host's attribute IDs. Cascades to a
		// fixed point via the Structural pass loop.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-filter-empty',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleFilterFoldEmpty,
			priority: 27,
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-project-empty',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleProjectFoldEmpty,
			priority: 27,
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-sort-empty',
			nodeType: PlanNodeType.Sort,
			phase: 'rewrite',
			fn: ruleSortFoldEmpty,
			priority: 27,
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-limit-empty',
			nodeType: PlanNodeType.LimitOffset,
			phase: 'rewrite',
			fn: ruleLimitOffsetFoldEmpty,
			priority: 27,
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-distinct-empty',
			nodeType: PlanNodeType.Distinct,
			phase: 'rewrite',
			fn: ruleDistinctFoldEmpty,
			priority: 27,
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-join-empty',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleJoinFoldEmpty,
			priority: 27,
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
			id: 'aggregate-physical',
			nodeType: PlanNodeType.Aggregate,
			phase: 'impl',
			fn: ruleAggregatePhysical,
			priority: 20
		});

		// Recognize lateral-top-1 asof. Runs in the Structural pass (before
		// predicate-pushdown at priority 20) so the lateral's Filter still
		// carries the asof predicate intact — predicate-pushdown would
		// otherwise consume it into the inner Retrieve pipeline.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'lateral-top1-asof',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleLateralTop1Asof,
			priority: 5
		});

		// Post-optimization pass rules (bottom-up) - for cleanup and caching
		// Physical join selection runs here (after Physical pass) so QuickPick can
		// see the full logical join tree before any physical conversion happens.
		// Monotonic-aware merge-join recognition runs first (lower priority) so
		// it can recognise cases where both sides advertise MonotonicOn but
		// `physical.ordering` does not match positionally — once it converts a
		// Join into a MergeJoin, the ordering-based rule no-ops on it.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'monotonic-merge-join',
			nodeType: PlanNodeType.Join,
			phase: 'impl',
			fn: ruleMonotonicMergeJoin,
			priority: 4
		});

		// Monotonic streaming-window recognition. Runs after monotonic-merge-join
		// (priority 4) so child joins have already become MergeJoins and
		// propagate their `monotonicOn`; runs before monotonic-limit-pushdown
		// (priority 8) but does not interact with it (different node type).
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'monotonic-window',
			nodeType: PlanNodeType.Window,
			phase: 'impl',
			fn: ruleMonotonicWindow,
			priority: 6
		});

		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'join-physical-selection',
			nodeType: PlanNodeType.Join,
			phase: 'impl',
			fn: ruleJoinPhysicalSelection,
			priority: 5
		});

		// Monotonic LIMIT/OFFSET pushdown: replace LimitOffset[/Sort]/access-leaf
		// with OrdinalSlice when the leaf advertises supportsOrdinalSeek. Runs in
		// PostOptimization so the leaf already carries its physical capabilities.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'monotonic-limit-pushdown',
			nodeType: PlanNodeType.LimitOffset,
			phase: 'impl',
			fn: ruleMonotonicLimitPushdown,
			priority: 8
		});

		// Monotonic range-scan recognition. Runs on physical leaves to annotate
		// `rangeBoundedOn` when a handled range/equality bounds the monotonic
		// column. Also runs on Filter nodes for the defensive escalation: drop
		// `monotonicOn` from a leaf when an unhandled range predicate sits in a
		// directly-overhead Filter. Runs after the limit pushdown (priority 9)
		// so that an OrdinalSlice rewrite has already replaced any leaf it
		// would have annotated; ordering vs. join-physical-selection (priority 5)
		// is not load-bearing — `rangeBoundedOn` is a pure annotation today and
		// the defensive drop only matters for downstream rules that check
		// `physical.monotonicOn` (asof/merge-join/limit-pushdown), which run
		// later in the same pass or have already run.
		const rangeAccessLeafTypes = [
			PlanNodeType.IndexScan,
			PlanNodeType.IndexSeek,
			PlanNodeType.SeqScan,
		];
		for (const nodeType of rangeAccessLeafTypes) {
			this.passManager.addRuleToPass(PassId.PostOptimization, {
				id: `monotonic-range-access-${nodeType}`,
				nodeType,
				phase: 'rewrite',
				fn: ruleMonotonicRangeAccess,
				priority: 9
			});
		}
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'monotonic-range-access-filter',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleMonotonicRangeAccess,
			priority: 9
		});

		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'mutating-subquery-cache',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleMutatingSubqueryCache,
			priority: 10
		});

		// AsofScan strategy selection (hash → merge). Runs after the leaves'
		// physical.ordering / monotonicOn are finalized (range-access at
		// priority 9) so the predicate-driven check can read them off.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'asof-strategy-select',
			nodeType: PlanNodeType.AsofScan,
			phase: 'impl',
			fn: ruleAsofStrategySelect,
			priority: 11
		});

		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'cte-optimization',
			nodeType: PlanNodeType.CTE,
			phase: 'rewrite',
			fn: ruleCteOptimization,
			priority: 20
		});

		// IN-subquery caching: wrap uncorrelated IN subquery sources in CacheNode
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'in-subquery-cache',
			nodeType: PlanNodeType.In,
			phase: 'rewrite',
			fn: ruleInSubqueryCache,
			priority: 25
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
			// Execute constant folding + structural passes (PassManager runs constant folding as its first pass)
			const structuralOnly = this.passManager.executeUpTo(plan, context, PassId.Structural);
			this.lastDiagnostics = { ...context.diagnostics };
			return structuralOnly;
		} finally {
			tracePhaseEnd('pre-physical-analysis');
		}
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
