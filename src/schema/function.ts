import type { Row, SqlValue } from '../common/types.js';
import { FunctionFlags } from '../common/constants.js';
import { SqlDataType } from '../common/types.js';
import type { Database } from '../core/database.js';

/**
 * Type for a scalar function implementation.
 */
export type ScalarFunc = (...args: SqlValue[]) => SqlValue | Promise<SqlValue>;

/**
 * Type for a table-valued function implementation.
 */
export type TableValuedFunc = (...args: SqlValue[]) => AsyncIterable<Row> | Promise<AsyncIterable<Row>>;

/**
 * Type for a database-aware table-valued function implementation.
 * Takes a database instance and SQL values, returns an async iterable of rows.
 */
export type IntegratedTableValuedFunc = (db: Database, ...args: SqlValue[]) => AsyncIterable<Row> | Promise<AsyncIterable<Row>>;

/**
 * Type for aggregate step function.
 */
export type AggregateReducer<T = any> = (accumulator: T, ...args: SqlValue[]) => T;

/**
 * Type for aggregate finalizer function.
 */
export type AggregateFinalizer<T = any> = (accumulator: T) => SqlValue;

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
	scalarImpl?: ScalarFunc;

	// Table-valued function
	/** Table-valued function implementation */
	tableValuedImpl?: TableValuedFunc | IntegratedTableValuedFunc;
	/** Column definitions for table-valued functions */
	columns?: TVFColumnInfo[];
	/** Whether this TVF requires database access as first parameter */
	isIntegrated?: boolean;

	// Aggregate function
	/** Aggregate step function */
	aggregateStepImpl?: AggregateReducer;
	/** Aggregate finalizer function */
	aggregateFinalizerImpl?: AggregateFinalizer;
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
