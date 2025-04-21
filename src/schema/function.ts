import type { SqliteContext } from '../func/context';
import type { SqlValue } from '../common/types';
import { FunctionFlags } from '../common/constants';

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
	xFunc?: (context: SqliteContext, args: ReadonlyArray<SqlValue>) => void;
	/** Callback for aggregate step function */
	xStep?: (context: SqliteContext, args: ReadonlyArray<SqlValue>) => void;
	/** Callback for aggregate final function */
	xFinal?: (context: SqliteContext) => void;
	/** Callback for window function value */
	xValue?: (context: SqliteContext) => void;
	/** Callback for window function inverse step */
	xInverse?: (context: SqliteContext, args: ReadonlyArray<SqlValue>) => void;
	/** Destructor for user data (if provided during registration) */
	xDestroy?: (userData: unknown) => void;
}

/** Key for storing/looking up functions */
export function getFunctionKey(name: string, numArgs: number): string {
	// Normalize name and handle varargs for consistent lookup
	return `${name.toLowerCase()}/${numArgs}`;
}
