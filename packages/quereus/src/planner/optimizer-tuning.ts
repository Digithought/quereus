/**
 * Optimizer tuning parameters - centralized configuration for magic numbers
 */
export interface OptimizerTuning {
	/** Row estimation defaults */
	readonly defaultRowEstimate: number;

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
}

/**
 * Default optimizer tuning parameters
 */
export const DEFAULT_TUNING: OptimizerTuning = {
	defaultRowEstimate: 1000,
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
	}
};
