import type { FunctionSchema } from '../schema/function';
import { FunctionFlags } from '../common/constants';
import type { SqliteContext } from './context';
import { type SqlValue, SqlDataType, StatusCode } from '../common/types';
import { SqliteError } from '../common/errors';

// --- Helper Interfaces for Registration ---

type ExpectedArgType = 'string' | 'number' | 'bigint' | 'boolean' | 'blob' | 'any';

interface ScalarFuncOptions {
	name: string;
	numArgs: number;
	flags?: FunctionFlags;
	argTypes?: ExpectedArgType[]; // Optional expected JS types for arguments
}

interface AggregateFuncOptions {
	name: string;
	numArgs: number;
	flags?: FunctionFlags;
	initialState?: any; // Optional initial state for accumulator
	argTypes?: ExpectedArgType[]; // Optional expected JS types for arguments
}

// --- Coercion Helper ---
function coerceArg(value: SqlValue, expectedType: ExpectedArgType | undefined): any {
	if (value === null || expectedType === undefined || expectedType === 'any') {
		return value;
	}

	try {
		switch (expectedType) {
			case 'string':
				// Blobs coerce to empty string in many contexts, others use String()
				return value instanceof Uint8Array ? '' : String(value);
			case 'number':
				// Explicitly handle boolean to number conversion common in SQL
				if (typeof value === 'boolean') return value ? 1 : 0;
				const num = Number(value);
				return isNaN(num) ? null : num; // Return null if coercion results in NaN
			case 'bigint':
				// Requires value to be string, number, boolean, or bigint itself
				return BigInt(value as any); // Let BigInt handle conversion/errors
			case 'boolean':
				// Use numeric evaluation: 0 or 0.0 is false, others true. Strings need parsing.
				if (typeof value === 'number') return value !== 0;
				if (typeof value === 'bigint') return value !== 0n;
				if (typeof value === 'string') {
					const lowerVal = value.trim().toLowerCase();
					if (lowerVal === 'true') return true;
					if (lowerVal === 'false') return false;
					const numVal = Number(value);
					return !isNaN(numVal) && numVal !== 0; // Coerce string to number first
				}
				return Boolean(value); // Fallback for actual boolean or blob (always true if exists)
			case 'blob':
				return value instanceof Uint8Array ? value : null;
		}
	} catch (e) {
		// Coercion failed (e.g., BigInt('abc'))
		console.warn(`Coercion failed for value ${value} to type ${expectedType}:`, e);
		return null;
	}
	return value; // Fallback if type not handled
}

// --- Registration Functions ---

/**
 * Creates a FunctionSchema for a scalar function from a plain JavaScript function.
 *
 * @param options Configuration options for the function.
 * @param jsFunc The JavaScript function implementation. It should return a value compatible with SqlValue.
 * @returns The generated FunctionSchema.
 */
export function createScalarFunction(options: ScalarFuncOptions, jsFunc: (...args: any[]) => SqlValue): FunctionSchema {
	const schema: FunctionSchema = {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC),
		xFunc: (context: SqliteContext, args: ReadonlyArray<SqlValue>) => {
			try {
				// Basic arity check
				if (options.numArgs >= 0 && args.length !== options.numArgs) {
					throw new Error(`Function ${options.name} called with ${args.length} arguments, expected ${options.numArgs}`);
				}

				// Coerce arguments based on options.argTypes
				const coercedArgs = args.map((arg, i) => coerceArg(arg, options.argTypes?.[i]));

				const result = jsFunc(...coercedArgs);

				// Basic Result Handling based on JS type
				if (result === null || result === undefined) {
					context.resultNull();
				} else if (typeof result === 'string') {
					context.resultText(result);
				} else if (typeof result === 'number') {
					if (Number.isInteger(result)) {
						context.resultInt64(BigInt(result)); // Prefer Int64 for integers
					} else {
						context.resultDouble(result);
					}
				} else if (typeof result === 'bigint') {
					context.resultInt64(result);
				} else if (result instanceof Uint8Array) {
					context.resultBlob(result);
				} else if (typeof result === 'boolean') {
					context.resultInt(result ? 1 : 0); // Store booleans as 0 or 1
				} else {
					// Unknown result type, try converting to string or error?
					console.warn(`Function ${options.name} returned unknown type: ${typeof result}. Coercing to NULL.`);
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
 * Creates a FunctionSchema for an aggregate function from step and final JavaScript functions.
 *
 * @param options Configuration options for the function.
 * @param stepFunc The function called for each row (accumulator, ...args) => newAccumulator.
 * @param finalFunc The function called at the end (accumulator) => finalResult.
 * @returns The generated FunctionSchema.
 */
export function createAggregateFunction(
	options: AggregateFuncOptions,
	stepFunc: (acc: any, ...args: any[]) => any,
	finalFunc: (acc: any) => SqlValue
): FunctionSchema {
	const schema: FunctionSchema = {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? FunctionFlags.UTF8, // Aggregates often aren't deterministic by default
		xStep: (context: SqliteContext, args: ReadonlyArray<SqlValue>) => {
			// REMOVE try...catch from xStep wrapper - let VDBE handle errors
			// try {
				// Basic arity check
				if (options.numArgs >= 0 && args.length !== options.numArgs) {
					// Throw error directly for VDBE to catch
					throw new Error(`Aggregate ${options.name} step called with ${args.length} arguments, expected ${options.numArgs}`);
				}
				let accumulator = context.getAggregateContext<any>();
				if (accumulator === undefined) {
					accumulator = options.initialState ?? null; // Use initial state or null
				}

				// Coerce arguments based on options.argTypes
				const coercedArgs = args.map((arg, i) => coerceArg(arg, options.argTypes?.[i]));

				const newAccumulator = stepFunc(accumulator, ...coercedArgs);
				context.setAggregateContext(newAccumulator);
			// } catch (e) {
				// Errors in xStep might be tricky - should they halt the query?
				// For now, log and potentially ignore, or set an error state?
			// REMOVED: console.error(`Error in aggregate function ${options.name} xStep:`, e);
				// We might need a way for context to signal an error from xStep that xFinal can check.
			// }
		},
		xFinal: (context: SqliteContext) => {
			try {
				let accumulator = context.getAggregateContext<any>();
				if (accumulator === undefined) {
					accumulator = options.initialState ?? null;
				}
				const result = finalFunc(accumulator);

				// Basic Result Handling based on JS type (same as scalar)
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
					console.warn(`Aggregate ${options.name} xFinal returned unknown type: ${typeof result}. Coercing to NULL.`);
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
