/**
 * Optimizer tuning parameters - centralized configuration for magic numbers
 */
export interface OptimizerTuning {
	/** Row estimation defaults */
	readonly defaultRowEstimate: number;

	/** Maximum optimization depth to prevent infinite recursion */
	readonly maxOptimizationDepth: number;

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
}

/**
 * Default optimizer tuning parameters
 */
export const DEFAULT_TUNING: OptimizerTuning = {
	defaultRowEstimate: 1000,
	maxOptimizationDepth: 50,
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
	}
};
