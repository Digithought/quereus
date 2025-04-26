import { FunctionFlags } from '../../common/constants';
import type { SqlValue } from '../../common/types';
import { createScalarFunction } from '../registration'; // Import helper
import { getSqlDataTypeName } from '../../util/comparison'; // Use the correct helper

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

// --- trim(X, Y?) ---
const jsTrim = (strVal: any, charsVal?: any): SqlValue => {
	if (strVal === null) return null;
	const str = String(strVal);
	if (charsVal === undefined || charsVal === null) {
		// Standard trim
		return str.trim();
	}
	const chars = String(charsVal);
	if (chars.length === 0) return str; // Trim nothing

	// Custom character trim (more complex)
	// SQLite trim removes *any* character from the Y string from both ends.
	// Regex approach: ^[chars]+|[chars]+$
	try {
		// Escape regex special characters in the chars string
		const escapedChars = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(`^[${escapedChars}]+|[${escapedChars}]+$`, 'g');
		return str.replace(regex, '');
	} catch (e) {
		// Invalid regex pattern possible if chars contains tricky sequences like ranges improperly.
		// Fallback to default trim or error? SQLite seems robust here.
		console.warn(`Error creating trim regex for chars: ${chars}`, e);
		return str.trim(); // Fallback? Or maybe return original string?
	}
};
export const trimFunc = createScalarFunction(
	{ name: 'trim', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	(x: any, y?: any) => jsTrim(x, y)
);

// --- ltrim(X, Y?) ---
const jsLtrim = (strVal: any, charsVal?: any): SqlValue => {
	if (strVal === null) return null;
	const str = String(strVal);
	if (charsVal === undefined || charsVal === null) {
		return str.trimStart(); // Standard left trim
	}
	const chars = String(charsVal);
	if (chars.length === 0) return str;

	try {
		const escapedChars = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(`^[${escapedChars}]+`, 'g');
		return str.replace(regex, '');
	} catch (e) {
		console.warn(`Error creating ltrim regex for chars: ${chars}`, e);
		return str.trimStart();
	}
};
export const ltrimFunc = createScalarFunction(
	{ name: 'ltrim', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	(x: any, y?: any) => jsLtrim(x, y)
);

// --- rtrim(X, Y?) ---
const jsRtrim = (strVal: any, charsVal?: any): SqlValue => {
	if (strVal === null) return null;
	const str = String(strVal);
	if (charsVal === undefined || charsVal === null) {
		return str.trimEnd(); // Standard right trim
	}
	const chars = String(charsVal);
	if (chars.length === 0) return str;

	try {
		const escapedChars = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(`[${escapedChars}]+$`, 'g');
		return str.replace(regex, '');
	} catch (e) {
		console.warn(`Error creating rtrim regex for chars: ${chars}`, e);
		return str.trimEnd();
	}
};
export const rtrimFunc = createScalarFunction(
	{ name: 'rtrim', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	(x: any, y?: any) => jsRtrim(x, y)
);

// --- replace(X, Y, Z) ---
const jsReplace = (strVal: any, patternVal: any, replacementVal: any): SqlValue => {
	if (strVal === null || patternVal === null || replacementVal === null) return null;

	const str = String(strVal);
	const pattern = String(patternVal);
	const replacement = String(replacementVal);

	if (pattern === '') return str; // Replacing empty string does nothing in SQLite

	// Simple string replacement (all occurrences)
	// Use split/join for basic replacement, or RegExp for more complex needs (but beware regex chars in `pattern`)
	// SQLite's replace is simple substring replacement, not regex.
	return str.split(pattern).join(replacement);
};
export const replaceFunc = createScalarFunction(
	{ name: 'replace', numArgs: 3, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsReplace
);

// --- instr(X, Y) ---
// Find the 1-based index of the first occurrence of Y within X
const jsInstr = (strVal: any, subVal: any): SqlValue => {
	if (strVal === null || subVal === null) return 0; // SQLite returns 0 for NULL input

	const str = String(strVal);
	const sub = String(subVal);

	if (sub.length === 0) return 0; // Searching for empty string returns 0
	if (str.length === 0) return 0; // Searching within empty string returns 0

	const index = str.indexOf(sub);
	return index === -1 ? 0 : index + 1; // Convert 0-based index to 1-based, or 0 if not found
};
export const instrFunc = createScalarFunction(
	{ name: 'instr', numArgs: 2, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsInstr
);

// --- typeof(X) ---
// Returns the SQLite fundamental datatype: 'null', 'integer', 'real', 'text', or 'blob'.
const jsTypeof = (arg: any): SqlValue => {
	return getSqlDataTypeName(arg);
};
export const typeofFunc = createScalarFunction(
	{ name: 'typeof', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsTypeof
);

// --- random() ---
// Returns a pseudo-random integer between -9223372036854775808 and +9223372036854775807.
const MAX_SQLITE_INT = 9223372036854775807n;
const MIN_SQLITE_INT = -9223372036854775808n;
const SQLITE_INT_RANGE = MAX_SQLITE_INT - MIN_SQLITE_INT + 1n;

const jsRandom = (): SqlValue => {
	// Generate a random BigInt within the full 64-bit signed range.
	// This is tricky with Math.random() which gives a float [0, 1).
	// A simple approach is to scale Math.random() to the range, but precision issues exist.
	// A better, but still not cryptographically secure, way is to build from multiple random calls.
	// Let's use a simpler version for now, returning a standard JS safe integer.
	// A full 64-bit random BigInt might need a crypto library.
	const randomInt = Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) + Number.MIN_SAFE_INTEGER;
	return BigInt(randomInt); // Return as BigInt even if in safe range for consistency with potential full range implementation
};
export const randomFunc = createScalarFunction(
	// NOT DETERMINISTIC
	{ name: 'random', numArgs: 0, flags: FunctionFlags.UTF8 },
	jsRandom
);

// --- randomblob(N) ---
// Returns an N-byte blob containing pseudo-random bytes.
const jsRandomBlob = (nVal: any): SqlValue => {
	if (typeof nVal !== 'number' && typeof nVal !== 'bigint') return null;
	const n = Number(nVal);
	if (!Number.isInteger(n) || n <= 0) return new Uint8Array(0); // N must be positive integer
	// SQLite caps at 1MB for safety? Let's add a reasonable cap.
	const byteLength = Math.min(n, 1024 * 1024); // Cap at 1MB

	const buffer = new Uint8Array(byteLength);
	// Use Math.random for simplicity, NOT cryptographically secure.
	for (let i = 0; i < byteLength; i++) {
		buffer[i] = Math.floor(Math.random() * 256);
	}
	return buffer;
};
export const randomblobFunc = createScalarFunction(
	// NOT DETERMINISTIC
	{ name: 'randomblob', numArgs: 1, flags: FunctionFlags.UTF8 },
	jsRandomBlob
);

// --- iif(X, Y, Z) ---
// If X is true, return Y, otherwise return Z.
const jsIif = (condition: any, trueVal: any, falseVal: any): SqlValue => {
	// Coerce condition according to SQLite rules (numeric non-zero is true)
	let isTrue: boolean;
	if (condition === null) {
		isTrue = false;
	} else if (typeof condition === 'number') {
		isTrue = condition !== 0;
	} else if (typeof condition === 'bigint') {
		isTrue = condition !== 0n;
	} else if (typeof condition === 'string') {
		const num = Number(condition); // Try coercing string to number
		isTrue = !isNaN(num) && num !== 0;
	} else {
		isTrue = Boolean(condition); // Booleans, Blobs (true if present)
	}

	return isTrue ? trueVal : falseVal;
};
export const iifFunc = createScalarFunction(
	{ name: 'iif', numArgs: 3, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsIif
);

// --- sqrt(X) ---
const jsSqrt = (arg: any): SqlValue => {
	if (arg === null) return null;
	const num = Number(arg);
	if (isNaN(num) || num < 0) return null; // sqrt of negative is NULL in SQLite
	return Math.sqrt(num);
};
export const sqrtFunc = createScalarFunction(
	{ name: 'sqrt', numArgs: 1, flags: FunctionFlags.DETERMINISTIC },
	jsSqrt
);

// --- pow(X, Y) / power(X, Y) ---
const jsPow = (base: any, exponent: any): SqlValue => {
	if (base === null || exponent === null) return null;
	const numBase = Number(base);
	const numExp = Number(exponent);
	if (isNaN(numBase) || isNaN(numExp)) return null;
	return Math.pow(numBase, numExp);
};
export const powFunc = createScalarFunction(
	{ name: 'pow', numArgs: 2, flags: FunctionFlags.DETERMINISTIC },
	jsPow
);
export const powerFunc = createScalarFunction(
	{ name: 'power', numArgs: 2, flags: FunctionFlags.DETERMINISTIC },
	jsPow // Alias
);

// --- floor(X) ---
const jsFloor = (arg: any): SqlValue => {
	if (arg === null) return null;
	const num = Number(arg);
	if (isNaN(num)) return null;
	return Math.floor(num);
};
export const floorFunc = createScalarFunction(
	{ name: 'floor', numArgs: 1, flags: FunctionFlags.DETERMINISTIC },
	jsFloor
);

// --- ceil(X) / ceiling(X) ---
const jsCeil = (arg: any): SqlValue => {
	if (arg === null) return null;
	const num = Number(arg);
	if (isNaN(num)) return null;
	return Math.ceil(num);
};
export const ceilFunc = createScalarFunction(
	{ name: 'ceil', numArgs: 1, flags: FunctionFlags.DETERMINISTIC },
	jsCeil
);
export const ceilingFunc = createScalarFunction(
	{ name: 'ceiling', numArgs: 1, flags: FunctionFlags.DETERMINISTIC },
	jsCeil // Alias
);
