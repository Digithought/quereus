import { createLogger } from '../common/logger.js';
import type { AggregateFinalizer, AggregateReducer, FunctionSchema, IntegratedTableValuedFunc, ScalarFunc, TableValuedFunc, TVFColumnInfo } from '../schema/function.js';
import { FunctionFlags } from '../common/constants.js';
import { SqlDataType } from '../common/types.js';

const log = createLogger('func:registration');

/**
 * Configuration options for scalar functions
 */
interface ScalarFuncOptions {
	/** Function name as it will be called in SQL */
	name: string;
	/** Number of arguments, or -1 for variable number */
	numArgs: number;
	/** Function behavior flags */
	flags?: FunctionFlags;
	/** Whether the function is deterministic (affects caching) */
	deterministic?: boolean;
	/** Return type affinity hint */
	affinity?: SqlDataType;
}

/**
 * Configuration options for table-valued functions
 */
interface TableValuedFuncOptions {
	/** Function name as it will be called in SQL */
	name: string;
	/** Number of arguments, or -1 for variable number */
	numArgs: number;
	/** Function behavior flags */
	flags?: FunctionFlags;
	/** Whether the function is deterministic (affects caching) */
	deterministic?: boolean;
	/** Column definitions for the table-valued function */
	columns?: TVFColumnInfo[];
}

/**
 * Configuration options for aggregate functions
 */
interface AggregateFuncOptions {
	/** Function name as it will be called in SQL */
	name: string;
	/** Number of arguments, or -1 for variable number */
	numArgs: number;
	/** Function behavior flags */
	flags?: FunctionFlags;
	/** Initial accumulator value */
	initialValue?: any;
}

/**
 * Creates a function schema for a scalar SQL function.
 * This is the primary way to register scalar functions in Quereus.
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function
 * @returns A FunctionSchema ready for registration
 */
export function createScalarFunction(options: ScalarFuncOptions, jsFunc: ScalarFunc): FunctionSchema {
	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		affinity: options.affinity,
		type: 'scalar',
		scalarImpl: jsFunc
	};
}

/**
 * Creates a function schema for a table-valued function.
 * Table-valued functions return AsyncIterable<Row> and can be used in FROM clauses.
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function
 * @returns A FunctionSchema ready for registration
 */
export function createTableValuedFunction(options: TableValuedFuncOptions, jsFunc: TableValuedFunc): FunctionSchema {
	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		type: 'table-valued',
		tableValuedImpl: jsFunc,
		columns: options.columns
	};
}

/**
 * Creates a function schema for a database-aware table-valued function.
 * These functions receive the database instance as their first parameter.
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function that takes (db, ...args)
 * @returns A FunctionSchema ready for registration
 */
export function createIntegratedTableValuedFunction(options: TableValuedFuncOptions, jsFunc: IntegratedTableValuedFunc): FunctionSchema {
	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		type: 'table-valued',
		tableValuedImpl: jsFunc as any, // We'll handle the database injection in the emitter
		columns: options.columns,
		// Mark this as database-aware so the emitter knows to inject the database
		isIntegrated: true
	};
}

/**
 * Creates an aggregate function using a functional reducer pattern.
 * This is more functional and easier to reason about than the step/final approach.
 */
export function createAggregateFunction<T = any>(
	options: AggregateFuncOptions,
	reducer: AggregateReducer<T>,
	finalizer: AggregateFinalizer<T> = (acc) => acc as any
): FunctionSchema {
	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? FunctionFlags.UTF8,
		type: 'aggregate',
		aggregateStepImpl: reducer,
		aggregateFinalizerImpl: finalizer,
		initialValue: options.initialValue
	};
}
