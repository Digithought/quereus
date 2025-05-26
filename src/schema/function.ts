import type { SqlValue } from '../common/types.js';
import { FunctionFlags } from '../common/constants.js';
import { SqlDataType } from '../common/types.js';

/**
 * Type for a scalar function implementation.
 */
export type ScalarFunctionImpl = (...args: SqlValue[]) => SqlValue | Promise<SqlValue>;

/**
 * Type for a table-valued function implementation.
 */
export type TableValuedFunctionImpl = (...args: SqlValue[]) => AsyncIterable<import('../common/types.js').Row> | Promise<AsyncIterable<import('../common/types.js').Row>>;

/**
 * Type for aggregate step function.
 */
export type AggregateStepImpl<T = any> = (accumulator: T, ...args: SqlValue[]) => T;

/**
 * Type for aggregate finalizer function.
 */
export type AggregateFinalizerImpl<T = any> = (accumulator: T) => SqlValue;

/**
 * Column information for table-valued functions.
 */
export interface TVFColumnInfo {
	name: string;
	type: SqlDataType;
	nullable?: boolean;
}

/**
 * Represents the registered definition of a user-defined function
 * (scalar, aggregate, table-valued, or window).
 */
export interface FunctionSchema {
	/** Function name (lowercase for consistent lookup) */
	name: string;
	/** Number of arguments (-1 for variable) */
	numArgs: number;
	/** Combination of FunctionFlags */
	flags: FunctionFlags;
	/** User data pointer passed during registration */
	userData?: unknown;
	/** Recommended affinity for the function's return value (optional, for scalar functions) */
	affinity?: SqlDataType;

	// Function type and implementation
	/** Function type */
	type: 'scalar' | 'aggregate' | 'table-valued' | 'window';

	// Scalar function
	/** Direct scalar function implementation */
	scalarImpl?: ScalarFunctionImpl;

	// Table-valued function
	/** Table-valued function implementation */
	tableValuedImpl?: TableValuedFunctionImpl;
	/** Column definitions for table-valued functions */
	columns?: TVFColumnInfo[];

	// Aggregate function
	/** Aggregate step function */
	aggregateStepImpl?: AggregateStepImpl;
	/** Aggregate finalizer function */
	aggregateFinalizerImpl?: AggregateFinalizerImpl;
	/** Initial accumulator value for aggregates */
	initialValue?: any;

	// Window function (for future use)
	/** Window function implementation */
	windowImpl?: (...args: any[]) => any;
}

/**
 * Creates a consistent key for storing/looking up functions
 *
 * @param name Function name
 * @param numArgs Number of arguments (-1 for variable argument count)
 * @returns A string key in the format "name/numArgs"
 */
export function getFunctionKey(name: string, numArgs: number): string {
	return `${name.toLowerCase()}/${numArgs}`;
}
