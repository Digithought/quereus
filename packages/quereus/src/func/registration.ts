import { createLogger } from '../common/logger.js';
import type {
	AggregateFinalizer,
	AggregateReducer,
	FunctionSchema,
	IntegratedTableValuedFunc,
	ScalarFunc,
	TableValuedFunc,
	ScalarFunctionSchema,
	TableValuedFunctionSchema,
	AggregateFunctionSchema
} from '../schema/function.js';
import { FunctionFlags } from '../common/constants.js';
import { SqlDataType } from '../common/types.js';
import type { ScalarType, RelationType } from '../common/datatype.js';

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
	/** Return type information */
	returnType?: ScalarType;
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
	/** Return type (relation) information */
	returnType?: RelationType;
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
	/** Whether the function is deterministic (affects caching) */
	deterministic?: boolean;
	/** Initial accumulator value */
	initialValue?: any;
	/** Return type information */
	returnType?: ScalarType;
}

/**
 * Creates a function schema for a scalar SQL function.
 * This is the primary way to register scalar functions in Quereus.
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function
 * @returns A FunctionSchema ready for registration
 */
export function createScalarFunction(options: ScalarFuncOptions, jsFunc: ScalarFunc): ScalarFunctionSchema {
	const returnType: ScalarType = options.returnType ?? {
		typeClass: 'scalar',
		affinity: SqlDataType.NUMERIC,
		nullable: true,
		isReadOnly: true
	};

	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType,
		implementation: jsFunc
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
export function createTableValuedFunction(options: TableValuedFuncOptions, jsFunc: TableValuedFunc): TableValuedFunctionSchema {
	const returnType: RelationType = options.returnType ?? {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false, // Table functions can return duplicates by default
		columns: [],
		keys: [],
		rowConstraints: []
	};

	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType,
		implementation: jsFunc
	};
}

/**
 * Creates a function schema for an integrated table-valued function.
 * Integrated functions receive the database instance as their first parameter.
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function
 * @returns A FunctionSchema ready for registration
 */
export function createIntegratedTableValuedFunction(options: TableValuedFuncOptions, jsFunc: IntegratedTableValuedFunc): TableValuedFunctionSchema {
	const returnType: RelationType = options.returnType ?? {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false, // Table functions can return duplicates by default
		columns: [],
		keys: [],
		rowConstraints: []
	};

	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType,
		implementation: jsFunc,
		isIntegrated: true
	};
}

/**
 * Creates a function schema for an aggregate function.
 * Aggregate functions use a step/finalize pattern to accumulate values.
 *
 * @param options Configuration options for the function
 * @param stepFunc Function called for each row
 * @param finalizeFunc Function called to get final result
 * @returns A FunctionSchema ready for registration
 */
export function createAggregateFunction(
	options: AggregateFuncOptions,
	stepFunc: AggregateReducer,
	finalizeFunc: AggregateFinalizer
): AggregateFunctionSchema {
	const returnType: ScalarType = options.returnType ?? {
		typeClass: 'scalar',
		affinity: SqlDataType.NUMERIC,
		nullable: true,
		isReadOnly: true
	};

	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType,
		stepFunction: stepFunc,
		finalizeFunction: finalizeFunc,
		initialValue: options.initialValue
	};
}
