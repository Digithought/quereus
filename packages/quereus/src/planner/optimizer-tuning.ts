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
	 * (the FK→PK fan-out recognition rule). All values are unitless cost
	 * comparators except `concurrency`, which is a row-time branch cap.
	 */
	readonly parallel: {
		/** Don't form a fan-out below this branch count. Default 2. */
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
	}
};
