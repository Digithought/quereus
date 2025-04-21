import { FunctionFlags } from '../../common/constants';
import type { SqlValue } from '../../common/types';
import { createScalarFunction } from '../registration'; // Import helper

// --- lower(X) ---
const jsLower = (arg: any): SqlValue => {
	return typeof arg === 'string' ? arg.toLowerCase() : null;
};
export const lowerFunc = createScalarFunction(
	{ name: 'lower', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsLower
);

// --- upper(X) ---
const jsUpper = (arg: any): SqlValue => {
	return typeof arg === 'string' ? arg.toUpperCase() : null;
};
export const upperFunc = createScalarFunction(
	{ name: 'upper', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsUpper
);

// --- length(X) ---
const jsLength = (arg: any): SqlValue => {
	if (arg === null) return null;
	if (typeof arg === 'string') return arg.length;
	if (arg instanceof Uint8Array) return arg.length;
	return null; // Other types -> NULL
};
export const lengthFunc = createScalarFunction(
	{ name: 'length', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsLength
);

// --- substr(X, Y, Z?) --- Also SUBSTRING
const jsSubstr = (str: any, start: any, len?: any): SqlValue => {
	if (str === null || start === null) return null;

	const s = String(str); // Coerce main arg to string
	let y = Number(start);
	let z = len === undefined ? undefined : Number(len);

	if (isNaN(y) || (z !== undefined && isNaN(z))) return null;

	// SQLite uses 1-based indexing, negative start counts from end
	y = Math.trunc(y);
	z = z === undefined ? undefined : Math.trunc(z);

	const strLen = s.length;
	let begin: number;

	if (y > 0) {
		begin = y - 1;
	} else if (y < 0) {
		begin = strLen + y;
	} else { // y == 0
		begin = 0;
	}
	begin = Math.max(0, begin); // Clamp start index

	let end: number;
	if (z === undefined) {
		end = strLen; // No length means to end of string
	} else if (z >= 0) {
		end = begin + z;
	} else { // Negative length is not standard SQL, SQLite returns empty string
		end = begin;
	}

	return s.substring(begin, end);
};
// Register both substr and substring
export const substrFunc = createScalarFunction(
	{ name: 'substr', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC }, // -1 allows 2 or 3 args
	(str: any, start: any, len?: any) => jsSubstr(str, start, len) // Wrap to handle variable args
);
export const substringFunc = createScalarFunction(
	{ name: 'substring', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	(str: any, start: any, len?: any) => jsSubstr(str, start, len)
);

// --- abs(X) ---
const jsAbs = (arg: any): SqlValue => {
	if (arg === null) return null;
	if (typeof arg === 'bigint') return arg < 0n ? -arg : arg;
	const num = Number(arg);
	if (isNaN(num)) return null;
	// SQLite returns integer if input looks like integer, otherwise float
	// Simple approach: return number (float)
	return Math.abs(num);
};
export const absFunc = createScalarFunction(
	{ name: 'abs', numArgs: 1, flags: FunctionFlags.DETERMINISTIC },
	jsAbs
);

// --- round(X, Y?) ---
const jsRound = (numVal: any, placesVal?: any): SqlValue => {
	if (numVal === null) return null;
	const x = Number(numVal);
	if (isNaN(x)) return null;

	let y = 0;
	if (placesVal !== undefined && placesVal !== null) {
		const numY = Number(placesVal);
		if (isNaN(numY)) return null;
		y = Math.trunc(numY);
	}

	// Simple rounding using toFixed (handles precision but returns string)
	// Then convert back to number. Be mindful of potential floating point issues.
	try {
		const factor = Math.pow(10, y);
		return Math.round(x * factor) / factor;
		// Alternative using toFixed (returns string, may be more precise for display)
		// return Number(x.toFixed(y));
	} catch {
		return null; // Handle potential errors in calculation
	}
};
export const roundFunc = createScalarFunction(
	{ name: 'round', numArgs: -1, flags: FunctionFlags.DETERMINISTIC },
	(x: any, y?: any) => jsRound(x, y)
);

// --- coalesce(...) ---
const jsCoalesce = (...args: any[]): SqlValue => {
	for (const arg of args) {
		if (arg !== null) {
			return arg;
		}
	}
	return null;
};
export const coalesceFunc = createScalarFunction(
	{ name: 'coalesce', numArgs: -1, flags: FunctionFlags.DETERMINISTIC }, // Variable args
	jsCoalesce
);

// --- nullif(X, Y) ---
import { compareSqlValues } from '../../util/comparison'; // Need comparison
const jsNullif = (argX: any, argY: any): SqlValue => {
	// Use the SQL comparison logic
	const comparison = compareSqlValues(argX, argY);
	return comparison === 0 ? null : argX;
};
export const nullifFunc = createScalarFunction(
	{ name: 'nullif', numArgs: 2, flags: FunctionFlags.DETERMINISTIC },
	jsNullif
);

// --- Simple LIKE implementation ---
function simpleLike(pattern: string, text: string): boolean {
	// Basic conversion: % -> .*, _ -> .
	// Escape regex characters in pattern, then replace SQL wildcards
	const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&'); // Escape most regex chars
	const regexPattern = escapedPattern.replace(/%/g, '.*').replace(/_/g, '.');
	try {
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(text);
	} catch (e) {
		console.error(`Invalid LIKE pattern converted to regex: ^${regexPattern}$`, e);
		return false; // Treat invalid pattern as no match
	}
}

const jsLike = (text: any, pattern: any): SqlValue => {
	if (text === null || pattern === null) return null;
	// TODO: Add ESCAPE clause handling
	return simpleLike(String(pattern), String(text));
};
export const likeFunc = createScalarFunction(
	{ name: 'like', numArgs: 2, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsLike
);

// --- Simple GLOB implementation ---
function simpleGlob(pattern: string, text: string): boolean {
	// Basic conversion: * -> .*, ? -> .
	// Escape regex characters, then replace GLOB wildcards
	const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&'); // Escape most regex chars
	// Handle GLOB special chars: * ? [] (SQLite also has set negation [^...]
	const regexPattern = escapedPattern
		.replace(/\\\*/g, '.*')   // Unescaped * becomes .* (greedy)
		.replace(/\\\?/g, '.');    // Unescaped ? becomes .
	// Basic range handling: Needs more work for proper [abc], [a-z] etc.
	// .replace(/\\\[([^\]]*)\\\]/g, '[$1]') // Pass through character sets (approximate)
	try {
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(text);
	} catch (e) {
		console.error(`Invalid GLOB pattern converted to regex: ^${regexPattern}$`, e);
		return false;
	}
}

const jsGlob = (pattern: any, text: any): SqlValue => {
	if (text === null || pattern === null) return null;
	return simpleGlob(String(pattern), String(text));
};
export const globFunc = createScalarFunction(
	{ name: 'glob', numArgs: 2, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsGlob
);
