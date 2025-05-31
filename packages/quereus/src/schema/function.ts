import type { Row, SqlValue } from '../common/types.js';
import { FunctionFlags } from '../common/constants.js';
import { SqlDataType } from '../common/types.js';
import type { Database } from '../core/database.js';
import type { BaseType, ScalarType, RelationType } from '../common/datatype.js';

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
 * Base interface for all function schemas with common properties.
 */
interface BaseFunctionSchema {
	/** Function name (lowercase for consistent lookup) */
	name: string;
	/** Number of arguments (-1 for variable) */
	numArgs: number;
	/** Combination of FunctionFlags */
	flags: FunctionFlags;
	/** User data pointer passed during registration */
	userData?: unknown;
	/** Return type information */
	returnType: BaseType;
}

/**
 * Schema for scalar functions that return a single value.
 */
export interface ScalarFunctionSchema extends BaseFunctionSchema {
	returnType: ScalarType;
	/** Direct scalar function implementation */
	implementation: ScalarFunc;
}

/**
 * Schema for table-valued functions that return rows.
 */
export interface TableValuedFunctionSchema extends BaseFunctionSchema {
	returnType: RelationType;
	/** Table-valued function implementation */
	implementation: TableValuedFunc | IntegratedTableValuedFunc;
	/** Whether this TVF requires database access as first parameter */
	isIntegrated?: boolean;
}

/**
 * Schema for aggregate functions.
 */
export interface AggregateFunctionSchema extends BaseFunctionSchema {
	returnType: ScalarType;
	/** Aggregate step function */
	stepFunction: AggregateReducer;
	/** Aggregate finalizer function */
	finalizeFunction: AggregateFinalizer;
	/** Initial accumulator value for aggregates */
	initialValue?: any;
}

/**
 * Schema for window functions (for future use).
 */
export interface WindowFunctionSchema extends BaseFunctionSchema {
	returnType: ScalarType;
	/** Window function implementation */
	implementation: (...args: any[]) => any;
}

/**
 * Union type representing all possible function schemas.
 */
export type FunctionSchema =
	| ScalarFunctionSchema
	| TableValuedFunctionSchema
	| AggregateFunctionSchema
	| WindowFunctionSchema;

/**
 * Type guards for function schema types.
 */
export function isScalarFunctionSchema(schema: FunctionSchema): schema is ScalarFunctionSchema {
	return schema.returnType.typeClass === 'scalar' && 'implementation' in schema && typeof schema.implementation === 'function';
}

export function isTableValuedFunctionSchema(schema: FunctionSchema): schema is TableValuedFunctionSchema {
	return schema.returnType.typeClass === 'relation';
}

export function isAggregateFunctionSchema(schema: FunctionSchema): schema is AggregateFunctionSchema {
	return 'stepFunction' in schema && 'finalizeFunction' in schema;
}

export function isWindowFunctionSchema(schema: FunctionSchema): schema is WindowFunctionSchema {
	return 'implementation' in schema && schema.returnType.typeClass === 'scalar' && !isScalarFunctionSchema(schema) && !isAggregateFunctionSchema(schema);
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

// Legacy compatibility - deprecated interfaces and column info
/**
 * @deprecated Use RelationType.columns instead
 * Column information for table-valued functions.
 */
export interface TVFColumnInfo {
	name: string;
	type: SqlDataType;
	nullable?: boolean;
}
