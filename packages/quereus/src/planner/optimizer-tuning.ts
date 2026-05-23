/**
 * Optimizer tuning parameters - centralized configuration for magic numbers
 */
export interface OptimizerTuning {
	/** Row estimation defaults */
	readonly defaultRowEstimate: number;

	/**
	 * Floor for the per-pass depth budget. The effective budget is
	 * `max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`,
	 * so this only matters for shallow inputs — wide-input plans scale up
	 * automatically via the headroom term.
	 */
	readonly maxOptimizationDepth: number;

	/**
	 * Extra depth allowance added on top of the input plan's measured depth
	 * when computing the per-pass depth budget. Absorbs rule-introduced
	 * wrapping; the depth guard is meant to catch pathological recursion,
	 * not punish naturally deep input shapes (wide AND trees, deep CASE, …).
	 */
	readonly optimizationDepthHeadroom: number;

	/**
	 * Maximum number of rule firings within a single pass before the pass
	 * aborts. Catches genuinely runaway rewrites independent of input shape;
	 * generously sized so it only trips on stuck rules.
	 */
	readonly maxRulesFired: number;

	/** Join optimization */
	readonly join: {
		/** Minimum left side rows to consider caching right side */
		readonly minLeftRowsForCaching: number;
		/** Maximum right side rows to cache */
		readonly maxRightRowsForCaching: number;
		/** Cache threshold multiplier (rightSize * multiplier) */
		readonly cacheThresholdMultiplier: number;
		/** Maximum cache threshold */
		readonly maxCacheThreshold: number;
	};

	/** CTE optimization */
	readonly cte: {
		/** Maximum CTE size to consider for caching */
		readonly maxSizeForCaching: number;
		/** Cache threshold multiplier for CTEs */
		readonly cacheThresholdMultiplier: number;
		/** Maximum cache threshold for CTEs */
		readonly maxCacheThreshold: number;
	};

	/** Recursive CTE configuration */
	readonly recursiveCte: {
		/** Maximum iterations before recursive CTE is terminated (0 = unlimited) */
		readonly maxIterations: number;
		/** Default cache threshold for CTE self-references */
		readonly defaultCacheThreshold: number;
	};

	/** Materialization advisory configuration */
	readonly cache: {
		/** Row threshold for switching from memory to spill strategy */
		readonly spillThreshold: number;
		/** Maximum memory buffer size for spill caches */
		readonly maxSpillBuffer: number;
		/** Whether spill caching is enabled */
		readonly spillEnabled: boolean;
	};

	/** AsofScan emitter strategy selection */
	readonly asof: {
		/**
		 * Right-side row count below which the hash strategy is preferred over
		 * merge. Below this threshold, hash buffering's constant factors beat
		 * the merge variant's per-row state bookkeeping.
		 */
		readonly mergeRowThreshold: number;
	};

	/**
	 * Delta executor cost fallback ratio.
	 *
	 * When a `DeltaSubscription` has accumulated more changed distinct binding
	 * tuples than `deltaPerRowFallbackRatio × estimatedRows(base)`, the kernel
	 * demotes the relation to global re-evaluation instead of running N
	 * per-binding residual executions. A first-cut threshold; a real cost
	 * comparator is a follow-up.
	 */
	readonly deltaPerRowFallbackRatio: number;

	/** Set of rule IDs to skip during optimization (test/debug use) */
	readonly disabledRules?: ReadonlySet<string>;

	/** Development and debugging options */
	readonly debug: {
		/** Whether to validate physical plans before emission */
		readonly validatePlan: boolean;
	};

	/** QuickPick join enumeration tuning */
	readonly quickpick?: {
		/** Maximum number of random greedy tours to evaluate */
		readonly maxTours: number;
		/** Time limit in milliseconds for enumeration (soft cap) */
		readonly timeLimitMs: number;
		/** Minimum estimated plan cost to trigger enumeration */
		readonly minTriggerCost: number;
		/** Enable/disable QuickPick globally */
		readonly enabled: boolean;
	};

	/**
	 * Parallel-execution rule tuning. Consumed by `rule-fanout-lookup-join`
	 * (the FK→PK fan-out recognition rule) and `rule-async-gather-union-all`
	 * (the UNION ALL gather recognition rule). All values are unitless cost
	 * comparators except `concurrency`, which is a row-time branch cap.
	 */
	readonly parallel: {
		/** Don't form a fan-out / gather below this branch count. Default 2. */
		readonly minBranches: number;
		/**
		 * Per-branch fixed overhead, charged against the latency win. Anchored
		 * against `COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW`; the value only matters
		 * relative to `expectedLatencyMs`, so the unit is "ms-equivalent cost".
		 * Default 1.0.
		 */
		readonly branchSetupCost: number;
		/** Static cap on in-flight branches per outer row. Default 8. */
		readonly concurrency: number;
		/**
		 * The slowest child of a UNION ALL chain must have at least this expected
		 * first-row latency (in milliseconds) for `rule-async-gather-union-all`
		 * to fold it into an `AsyncGatherNode`. Set high enough that local-only
		 * memory-vtab plans never trigger — `expectedLatencyMs` is 0 throughout
		 * those plans, so any positive value keeps the rule inert there. Default
		 * 25 ms (matches the high-latency vtab fixture used by the parallel
		 * optimizer tests, so the same fixture exercises both this rule and the
		 * fan-out rule).
		 */
		readonly gatherThresholdMs: number;
		/**
		 * Minimum `right.physical.expectedLatencyMs` (in milliseconds) on a
		 * physical hash join's build side for `rule-eager-prefetch-probe` to wrap
		 * the probe (`left`) input in an `EagerPrefetchNode`. Like
		 * `gatherThresholdMs`, any positive value keeps the rule inert on
		 * memory-vtab plans (their leaves declare `expectedLatencyMs=0`). Default
		 * 25 ms — the same high-latency vtab fixture value the other parallel
		 * rules use, so no test-side tuning is needed to exercise the rule.
		 */
		readonly prefetchProbeThresholdMs: number;
		/**
		 * Buffer size handed to the `EagerPrefetchNode` the prefetch-probe rule
		 * inserts. Default 64 — mirrors the `EagerPrefetchNode` constructor
		 * default so the in-tree default matches what manual construction
		 * already produces.
		 */
		readonly prefetchBufferSize: number;
	};
}

/**
 * Default optimizer tuning parameters
 */
export const DEFAULT_TUNING: OptimizerTuning = {
	defaultRowEstimate: 1000,
	maxOptimizationDepth: 50,
	optimizationDepthHeadroom: 16,
	maxRulesFired: 100000,
	join: {
		minLeftRowsForCaching: 1,
		maxRightRowsForCaching: 50000,
		cacheThresholdMultiplier: 2,
		maxCacheThreshold: 10000
	},
	cte: {
		maxSizeForCaching: 50000,
		cacheThresholdMultiplier: 2,
		maxCacheThreshold: 20000
	},
	recursiveCte: {
		maxIterations: 10000,
		defaultCacheThreshold: 10000
	},
	cache: {
		spillThreshold: 100000,
		maxSpillBuffer: 10000,
		spillEnabled: true
	},
	asof: {
		mergeRowThreshold: 10000
	},
	deltaPerRowFallbackRatio: 0.5,
	debug: {
		validatePlan: false // Default to disabled in production
	},
	quickpick: {
		maxTours: 100,
		timeLimitMs: 100,
		minTriggerCost: 0,
		enabled: true
	},
	parallel: {
		minBranches: 2,
		// 1.0 ≈ COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW; this is "ms-equivalent" because
		// it is compared directly against `expectedLatencyMs * (N - cap)` savings.
		branchSetupCost: 1.0,
		concurrency: 8,
		// ≥ this many ms on the slowest child of a unionAll chain triggers the
		// parallel gather. 25 ms matches the synthetic high-latency vtab fixture;
		// memory-vtab plans declare 0 ms so they never cross this gate.
		gatherThresholdMs: 25,
		// ≥ this many ms on a hash join's build (right) side triggers wrapping
		// the probe (left) side in EagerPrefetch. 25 ms matches the synthetic
		// high-latency vtab fixture; memory-vtab plans declare 0 ms so the rule
		// stays inert on local-only plans.
		prefetchProbeThresholdMs: 25,
		// Ring-buffer size for the inserted EagerPrefetchNode; mirrors the node's
		// own constructor default.
		prefetchBufferSize: 64,
	}
};
