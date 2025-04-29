import type { IndexConstraintOp } from '../../../common/constants.js';
import type { SqlValue } from '../../../common/types.js';
import type { BTreeKey } from '../types.js';

/** Describes an equality constraint for a scan plan */
export interface ScanPlanEqConstraint {
	op: IndexConstraintOp.EQ;
	value: BTreeKey; // Can be composite for multi-column EQ
}

/** Describes a range bound for a scan plan */
export interface ScanPlanRangeBound {
	op: IndexConstraintOp.GT | IndexConstraintOp.GE | IndexConstraintOp.LT | IndexConstraintOp.LE;
	value: SqlValue; // Range bounds typically apply to the first column
}

/**
 * Encapsulates the details needed to execute a scan across layers.
 * Derived from IndexInfo during xBestIndex/xFilter.
 */
export interface ScanPlan {
	/** Name of the index to scan ('primary' or secondary index name) */
	indexName: string | 'primary';
	/** Scan direction */
	descending: boolean;
	/** Specific key for an equality scan (used if planType is EQ) */
	equalityKey?: BTreeKey;
	/** Lower bound for a range scan (used if planType is RANGE_*) */
	lowerBound?: ScanPlanRangeBound;
	/** Upper bound for a range scan (used if planType is RANGE_*) */
	upperBound?: ScanPlanRangeBound;
	/** The original idxNum from xBestIndex, potentially useful for cursor logic */
	idxNum?: number;
	/** The original idxStr from xBestIndex, potentially useful for debugging */
	idxStr?: string | null;

	// Additional fields might be needed for complex filtering passed down
	// e.g., remaining constraints not handled by index bounds/equality.
	// remainingConstraints?: ReadonlyArray<{ constraint: IndexConstraint, value: SqlValue }>;
}
