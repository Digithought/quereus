import type { QuereusContext } from '../func/context';
import type { SqlValue } from '../common/types.js';
import { FunctionFlags } from '../common/constants.js';
import { SqlDataType } from '../common/types.js';

/**
 * Represents the registered definition of a user-defined function
 * (scalar, aggregate, or window).
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
	/** Callback for scalar functions */
	xFunc?: (context: QuereusContext, args: ReadonlyArray<SqlValue>) => void;
	/** Callback for aggregate step function */
	xStep?: (context: QuereusContext, args: ReadonlyArray<SqlValue>) => void;
	/** Callback for aggregate final function */
	xFinal?: (context: QuereusContext) => void;
	/** Callback for window function value */
	xValue?: (context: QuereusContext) => void;
	/** Callback for window function inverse step */
	xInverse?: (context: QuereusContext, args: ReadonlyArray<SqlValue>) => void;
	/** Destructor for user data (if provided during registration) */
	xDestroy?: (userData: unknown) => void;
	/** Recommended affinity for the function's return value (optional) */
	affinity?: SqlDataType;
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
