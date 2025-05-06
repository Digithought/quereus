import { createLogger } from '../common/logger.js';
import type { FunctionSchema } from '../schema/function.js';
import { FunctionFlags } from '../common/constants.js';
import type { SqliteContext } from './context.js';
import { type SqlValue, StatusCode } from '../common/types.js';

const log = createLogger('func:registration');
const warnLog = log.extend('warn');

/**
 * Supported argument type specifications for function argument coercion
 */
type ExpectedArgType = 'string' | 'number' | 'bigint' | 'boolean' | 'blob' | 'any';

/**
 * Configuration options for scalar SQL functions
 */
interface ScalarFuncOptions {
	/** Function name as it will be called in SQL */
	name: string;
	/** Number of arguments, or -1 for variable number */
	numArgs: number;
	/** Function behavior flags */
	flags?: FunctionFlags;
	/** Optional type specifications for arguments */
	argTypes?: ExpectedArgType[];
}

/**
 * Configuration options for aggregate SQL functions
 */
interface AggregateFuncOptions {
	/** Function name as it will be called in SQL */
	name: string;
	/** Number of arguments, or -1 for variable number */
	numArgs: number;
	/** Function behavior flags */
	flags?: FunctionFlags;
	/** Initial state for the accumulator */
	initialState?: any;
	/** Optional type specifications for arguments */
	argTypes?: ExpectedArgType[];
}

/**
 * Coerces a SQL value to the specified JavaScript type
 *
 * @param value The SQL value to coerce
 * @param expectedType The desired JavaScript type
 * @returns The coerced value or null if coercion failed
 */
function coerceArg(value: SqlValue, expectedType: ExpectedArgType | undefined): any {
	if (value === null || expectedType === undefined || expectedType === 'any') {
		return value;
	}

	try {
		switch (expectedType) {
			case 'string':
				return value instanceof Uint8Array ? '' : String(value);
			case 'number':
				if (typeof value === 'boolean') return value ? 1 : 0;
				const num = Number(value);
				return isNaN(num) ? null : num;
			case 'bigint':
				return BigInt(value as any);
			case 'boolean':
				if (typeof value === 'number') return value !== 0;
				if (typeof value === 'bigint') return value !== 0n;
				if (typeof value === 'string') {
					const lowerVal = value.trim().toLowerCase();
					if (lowerVal === 'true') return true;
					if (lowerVal === 'false') return false;
					const numVal = Number(value);
					return !isNaN(numVal) && numVal !== 0;
				}
				return Boolean(value);
			case 'blob':
				return value instanceof Uint8Array ? value : null;
		}
	} catch (e) {
		warnLog('Coercion failed for value %s to type %s: %O', value, expectedType, e);
		return null;
	}
	return value;
}

/**
 * Creates a function schema for a scalar SQL function from a JavaScript implementation
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function
 * @returns A FunctionSchema ready for registration
 */
export function createScalarFunction(options: ScalarFuncOptions, jsFunc: (...args: any[]) => SqlValue): FunctionSchema {
	const schema: FunctionSchema = {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC),
		xFunc: (context: SqliteContext, args: ReadonlyArray<SqlValue>) => {
			try {
				if (options.numArgs >= 0 && args.length !== options.numArgs) {
					throw new Error(`Function ${options.name} called with ${args.length} arguments, expected ${options.numArgs}`);
				}

				const coercedArgs = args.map((arg, i) => coerceArg(arg, options.argTypes?.[i]));
				const result = jsFunc(...coercedArgs);

				if (result === null || result === undefined) {
					context.resultNull();
				} else if (typeof result === 'string') {
					context.resultText(result);
				} else if (typeof result === 'number') {
					if (Number.isInteger(result)) {
						context.resultInt64(BigInt(result));
					} else {
						context.resultDouble(result);
					}
				} else if (typeof result === 'bigint') {
					context.resultInt64(result);
				} else if (result instanceof Uint8Array) {
					context.resultBlob(result);
				} else if (typeof result === 'boolean') {
					context.resultInt(result ? 1 : 0);
				} else {
					context.resultNull();
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				context.resultError(`Error in function ${options.name}: ${message}`, StatusCode.ERROR);
			}
		},
	};
	return schema;
}

/**
 * Creates a function schema for an aggregate SQL function from JavaScript step and final functions
 *
 * @param options Configuration options for the function
 * @param stepFunc Function called for each row to update the accumulator
 * @param finalFunc Function called after all rows to produce the final result
 * @returns A FunctionSchema ready for registration
 */
export function createAggregateFunction(
	options: AggregateFuncOptions,
	stepFunc: (acc: any, ...args: any[]) => any,
	finalFunc: (acc: any) => SqlValue
): FunctionSchema {
	const schema: FunctionSchema = {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? FunctionFlags.UTF8,
		xStep: (context: SqliteContext, args: ReadonlyArray<SqlValue>) => {
			if (options.numArgs >= 0 && args.length !== options.numArgs) {
				throw new Error(`Aggregate ${options.name} step called with ${args.length} arguments, expected ${options.numArgs}`);
			}

			let accumulator = context.getAggregateContext<any>();
			if (accumulator === undefined) {
				accumulator = options.initialState ?? null;
			}

			const coercedArgs = args.map((arg, i) => coerceArg(arg, options.argTypes?.[i]));
			const newAccumulator = stepFunc(accumulator, ...coercedArgs);
			context.setAggregateContext(newAccumulator);
		},
		xFinal: (context: SqliteContext) => {
			try {
				let accumulator = context.getAggregateContext<any>();
				if (accumulator === undefined) {
					accumulator = options.initialState ?? null;
				}
				const result = finalFunc(accumulator);

				if (result === null || result === undefined) {
					context.resultNull();
				} else if (typeof result === 'string') {
					context.resultText(result);
				} else if (typeof result === 'number') {
					if (Number.isSafeInteger(result)) {
						context.resultInt(result);
					} else if (Number.isInteger(result)) {
						context.resultInt64(BigInt(result));
					} else {
						context.resultDouble(result);
					}
				} else if (typeof result === 'bigint') {
					context.resultInt64(result);
				} else if (result instanceof Uint8Array) {
					context.resultBlob(result);
				} else if (typeof result === 'boolean') {
					context.resultInt(result ? 1 : 0);
				} else {
					context.resultNull();
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				context.resultError(`Error in aggregate function ${options.name} xFinal: ${message}`, StatusCode.ERROR);
			}
		},
	};
	return schema;
}
