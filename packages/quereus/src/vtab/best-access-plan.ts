/**
 * Modern, type-safe replacement for xBestIndex API
 * Provides better type safety, clearer intent, and extensibility for future optimizations
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { quereusError } from '../common/errors.js';
import { StatusCode, type SqlDataType, type SqlValue } from '../common/types.js';

/**
 * Constraint operators that can be pushed down to virtual tables
 */
export type ConstraintOp = '=' | '>' | '>=' | '<' | '<=' | 'MATCH' | 'LIKE' | 'GLOB' | 'IS NULL' | 'IS NOT NULL' | 'IN' | 'NOT IN';

/**
 * Column metadata provided to virtual tables for planning
 */
export interface ColumnMeta {
	/** Column index in the table */
	index: number;
	/** Column name */
	name: string;
	/** SQL type information */
	type: SqlDataType;
	/** Whether this column is part of the primary key */
	isPrimaryKey: boolean;
	/** Whether this column has a unique constraint */
	isUnique: boolean;
}

/**
 * A predicate constraint extracted from WHERE clause
 */
export interface PredicateConstraint {
	/** Column index this constraint applies to */
	columnIndex: number;
	/** Constraint operator */
	op: ConstraintOp;
	/** Constant value if this is a column-constant comparison */
	value?: SqlValue;
	/** Whether this constraint can be used by the virtual table */
	usable: boolean;
}

/**
 * Ordering specification for ORDER BY clauses
 */
export interface OrderingSpec {
	/** Column index to order by */
	columnIndex: number;
	/** True for descending order, false for ascending */
	desc: boolean;
	/** Whether NULL values should come first or last */
	nullsFirst?: boolean;
}

/**
 * Request object passed to getBestAccessPlan containing query planning information
 */
export interface BestAccessPlanRequest {
	/** Column metadata for the table */
	columns: readonly ColumnMeta[];
	/** Extracted predicate constraints from WHERE clause */
	filters: readonly PredicateConstraint[];
	/** Required ordering that ancestor nodes need (ORDER BY) */
	requiredOrdering?: readonly OrderingSpec[];
	/** LIMIT value known at plan time */
	limit?: number | null;
	/** Estimated rows hint from planner (may be unknown) */
	estimatedRows?: number;
}

/**
 * Result object returned by getBestAccessPlan describing the chosen query plan
 */
export interface BestAccessPlanResult {
	/** Which filters were handled by the virtual table (parallel to filters array) */
	handledFilters: readonly boolean[];
	/** Optional JavaScript filter function for residual predicates */
	residualFilter?: (row: any) => boolean;
	/** Estimated cost in arbitrary virtual CPU units */
	cost: number;
	/** Estimated number of rows this plan will return */
	rows: number | undefined;
	/** Ordering guaranteed by this access plan */
	providesOrdering?: readonly OrderingSpec[];
	/** Whether this plan guarantees unique rows (helps DISTINCT optimization) */
	isSet?: boolean;
	/** Free-text explanation for debugging */
	explains?: string;
}

/**
 * Builder class for constructing access plan results
 */
export class AccessPlanBuilder {
	private result: Partial<BestAccessPlanResult> = {};

	/**
	 * Create a full table scan access plan
	 */
	static fullScan(estimatedRows: number): AccessPlanBuilder {
		return new AccessPlanBuilder()
			.setCost(estimatedRows * 1.0) // Sequential scan cost
			.setRows(estimatedRows)
			.setExplanation('Full table scan');
	}

	/**
	 * Create an equality match access plan (index seek)
	 */
	static eqMatch(matchedRows: number, indexCost: number = 0.5): AccessPlanBuilder {
		return new AccessPlanBuilder()
			.setCost(indexCost + matchedRows * 0.3)
			.setRows(matchedRows)
			.setIsSet(matchedRows <= 1)
			.setExplanation('Index equality seek');
	}

	/**
	 * Create a range scan access plan
	 */
	static rangeScan(estimatedRows: number, indexCost: number = 0.3): AccessPlanBuilder {
		return new AccessPlanBuilder()
			.setCost(indexCost + estimatedRows * 0.5)
			.setRows(estimatedRows)
			.setExplanation('Index range scan');
	}

	/**
	 * Set the estimated cost of this access plan
	 */
	setCost(cost: number): this {
		this.result.cost = cost;
		return this;
	}

	/**
	 * Set the estimated number of rows
	 */
	setRows(rows: number | undefined): this {
		this.result.rows = rows;
		return this;
	}

	/**
	 * Set which filters are handled by this plan
	 */
	setHandledFilters(handledFilters: readonly boolean[]): this {
		this.result.handledFilters = handledFilters;
		return this;
	}

	/**
	 * Set the ordering provided by this plan
	 */
	setOrdering(ordering: readonly OrderingSpec[]): this {
		this.result.providesOrdering = ordering;
		return this;
	}

	/**
	 * Set whether this plan produces unique rows
	 */
	setIsSet(isSet: boolean): this {
		this.result.isSet = isSet;
		return this;
	}

	/**
	 * Set an explanation for debugging
	 */
	setExplanation(explanation: string): this {
		this.result.explains = explanation;
		return this;
	}

	/**
	 * Set a residual filter function
	 */
	setResidualFilter(filter: (row: any) => boolean): this {
		this.result.residualFilter = filter;
		return this;
	}

	/**
	 * Build the final access plan result
	 */
	build(): BestAccessPlanResult {
		// Ensure required fields are set
		if (this.result.cost === undefined) {
			quereusError('Access plan cost must be set', StatusCode.INTERNAL);
		}
		if (this.result.handledFilters === undefined) {
			this.result.handledFilters = [];
		}

		return this.result as BestAccessPlanResult;
	}
}

/**
 * Validation function for access plan results
 * Throws if the plan violates basic contracts
 */
export function validateAccessPlan(
	request: BestAccessPlanRequest,
	result: BestAccessPlanResult
): void {
	// Validate handledFilters array length
	if (result.handledFilters.length !== request.filters.length) {
		quereusError(
			`handledFilters length (${result.handledFilters.length}) must match filters length (${request.filters.length})`,
			StatusCode.FORMAT
		);
	}

	// Validate cost is non-negative
	if (result.cost < 0) {
		quereusError(`Access plan cost cannot be negative: ${result.cost}`, StatusCode.INTERNAL);
	}

	// Validate rows is non-negative if specified
	if (result.rows !== undefined && result.rows < 0) {
		quereusError(`Access plan rows cannot be negative: ${result.rows}`, StatusCode.INTERNAL);
	}

	// Validate ordering column indexes
	if (result.providesOrdering) {
		for (const order of result.providesOrdering) {
			if (order.columnIndex < 0 || order.columnIndex >= request.columns.length) {
				quereusError(
					`Invalid ordering column index ${order.columnIndex}, must be 0-${request.columns.length - 1}`,
					StatusCode.FORMAT
				);
			}
		}
	}
}


