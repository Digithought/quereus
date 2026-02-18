/**
 * Cost model helpers for query optimization
 * Provides consistent cost estimation formulas across the optimizer
 */

import { quereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";

/**
 * Basic cost constants (in arbitrary "virtual CPU units")
 */
export const COST_CONSTANTS = {
	/** Cost per row for sequential scan */
	SEQ_SCAN_PER_ROW: 1.0,
	/** Base cost for starting a sequential scan */
	SEQ_SCAN_BASE: 0.1,

	/** Cost per row for index seek */
	INDEX_SEEK_PER_ROW: 0.3,
	/** Base cost for index seek operation */
	INDEX_SEEK_BASE: 0.5,

	/** Cost per row for index scan */
	INDEX_SCAN_PER_ROW: 0.5,
	/** Base cost for index scan operation */
	INDEX_SCAN_BASE: 0.3,

	/** Cost per row for sorting */
	SORT_PER_ROW: 2.0,
	/** Log base for sort cost calculations */
	SORT_LOG_BASE: 2,

	/** Cost per row for filtering */
	FILTER_PER_ROW: 0.2,

	/** Cost per row for projection */
	PROJECT_PER_ROW: 0.1,

	/** Cost per output row for aggregation */
	AGGREGATE_PER_GROUP: 1.5,
	/** Cost per input row for aggregation */
	AGGREGATE_PER_INPUT_ROW: 0.3,

	/** Cost per row for nested loop join (inner side) */
	NL_JOIN_PER_INNER_ROW: 0.1,
	/** Cost per row for nested loop join (outer side) */
	NL_JOIN_PER_OUTER_ROW: 1.0,

	/** Cost per row for bloom/hash join build phase */
	HASH_JOIN_BUILD_PER_ROW: 0.8,
	/** Cost per row for bloom/hash join probe phase */
	HASH_JOIN_PROBE_PER_ROW: 0.4,

	/** Cost per row for distinct operation */
	DISTINCT_PER_ROW: 1.2,

	/** Cost per row for limit operation */
	LIMIT_PER_ROW: 0.05,

	/** Cost per row for cache access */
	CACHE_ACCESS_PER_ROW: 0.1,
	/** Cost per row for cache population */
	CACHE_POPULATE_PER_ROW: 0.2,
} as const;

/**
 * Calculate cost for sequential scan
 */
export function seqScanCost(rows: number): number {
	return COST_CONSTANTS.SEQ_SCAN_BASE + (rows * COST_CONSTANTS.SEQ_SCAN_PER_ROW);
}

/**
 * Calculate cost for index seek (point lookup or tight range)
 */
export function indexSeekCost(rows: number): number {
	return COST_CONSTANTS.INDEX_SEEK_BASE + (rows * COST_CONSTANTS.INDEX_SEEK_PER_ROW);
}

/**
 * Calculate cost for index scan (range scan with ordering)
 */
export function indexScanCost(rows: number): number {
	return COST_CONSTANTS.INDEX_SCAN_BASE + (rows * COST_CONSTANTS.INDEX_SCAN_PER_ROW);
}

/**
 * Calculate cost for sorting operation
 * Uses O(n log n) complexity
 */
export function sortCost(rows: number): number {
	if (rows <= 1) return COST_CONSTANTS.SORT_PER_ROW;
	return rows * Math.log2(rows) * COST_CONSTANTS.SORT_PER_ROW;
}

/**
 * Calculate cost for filter operation
 */
export function filterCost(inputRows: number): number {
	return inputRows * COST_CONSTANTS.FILTER_PER_ROW;
}

/**
 * Calculate cost for projection operation
 */
export function projectCost(rows: number, projectionCount: number = 1): number {
	return rows * projectionCount * COST_CONSTANTS.PROJECT_PER_ROW;
}

/**
 * Calculate cost for aggregation operation
 */
export function aggregateCost(inputRows: number, outputRows: number): number {
	return (inputRows * COST_CONSTANTS.AGGREGATE_PER_INPUT_ROW) +
		   (outputRows * COST_CONSTANTS.AGGREGATE_PER_GROUP);
}

/**
 * Calculate cost for nested loop join
 */
export function nestedLoopJoinCost(outerRows: number, innerRows: number): number {
	return (outerRows * COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW) +
		   (outerRows * innerRows * COST_CONSTANTS.NL_JOIN_PER_INNER_ROW);
}

/**
 * Calculate cost for bloom/hash join
 */
export function hashJoinCost(buildRows: number, probeRows: number): number {
	return (buildRows * COST_CONSTANTS.HASH_JOIN_BUILD_PER_ROW) +
		   (probeRows * COST_CONSTANTS.HASH_JOIN_PROBE_PER_ROW);
}

/**
 * Calculate cost for distinct operation
 */
export function distinctCost(rows: number): number {
	// Distinct typically involves sorting or hashing
	return rows * COST_CONSTANTS.DISTINCT_PER_ROW;
}

/**
 * Calculate cost for limit operation
 */
export function limitCost(inputRows: number, limitValue: number): number {
	const processedRows = Math.min(inputRows, limitValue);
	return processedRows * COST_CONSTANTS.LIMIT_PER_ROW;
}

/**
 * Calculate cost for cache operations
 */
export function cacheCost(rows: number, accessCount: number = 1): number {
	const populateCost = rows * COST_CONSTANTS.CACHE_POPULATE_PER_ROW;
	const accessCost = rows * accessCount * COST_CONSTANTS.CACHE_ACCESS_PER_ROW;
	return populateCost + accessCost;
}

/**
 * Helper to choose the minimum cost option
 */
export function chooseCheapest<T>(options: Array<{ cost: number; option: T }>): T {
	if (options.length === 0) {
		quereusError('No options provided to chooseCheapest', StatusCode.INTERNAL);
	}
	return options.reduce((min, current) =>
		current.cost < min.cost ? current : min
	).option;
}
