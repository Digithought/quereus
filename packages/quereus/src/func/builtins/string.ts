import { createAggregateFunction, createScalarFunction, createTableValuedFunction } from '../registration.js';
import type { Row, SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('func:builtins:scalar');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

// --- length(X) ---
export const lengthFunc = createScalarFunction(
	{ name: 'length', numArgs: 1, deterministic: true },
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;
		if (typeof arg === 'string') return arg.length;
		if (arg instanceof Uint8Array) return arg.length;
		return null; // Other types -> NULL
	}
);

// --- substr(X, Y, Z?) --- Also SUBSTRING
export const substrFunc = createScalarFunction(
	{ name: 'substr', numArgs: -1, deterministic: true },
	(str: SqlValue, start: SqlValue, len?: SqlValue): SqlValue => {
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
	}
);

export const substringFunc = createScalarFunction(
	{ name: 'substring', numArgs: -1, deterministic: true },
	(str: SqlValue, start: SqlValue, len?: SqlValue): SqlValue => {
		if (str === null || start === null) return null;

		const s = String(str);
		let y = Number(start);
		let z = len === undefined ? undefined : Number(len);

		if (isNaN(y) || (z !== undefined && isNaN(z))) return null;

		y = Math.trunc(y);
		z = z === undefined ? undefined : Math.trunc(z);

		const strLen = s.length;
		let begin: number;

		if (y > 0) {
			begin = y - 1;
		} else if (y < 0) {
			begin = strLen + y;
		} else {
			begin = 0;
		}
		begin = Math.max(0, begin);

		let end: number;
		if (z === undefined) {
			end = strLen;
		} else if (z >= 0) {
			end = begin + z;
		} else {
			end = begin;
		}

		return s.substring(begin, end);
	}
);

// --- Simple LIKE implementation ---
function simpleLike(pattern: string, text: string): boolean {
	const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
	const regexPattern = escapedPattern.replace(/%/g, '.*').replace(/_/g, '.');
	try {
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(text);
	} catch (e) {
		errorLog('Invalid LIKE pattern converted to regex: ^%s$, %O', regexPattern, e);
		return false;
	}
}

export const likeFunc = createScalarFunction(
	{ name: 'like', numArgs: 2, deterministic: true },
	(pattern: SqlValue, text: SqlValue): SqlValue => {
		if (text === null || pattern === null) return null;
		return simpleLike(String(pattern), String(text)) ? 1 : 0;
	}
);

// --- Simple GLOB implementation ---
function simpleGlob(pattern: string, text: string): boolean {
	const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
	const regexPattern = escapedPattern
		.replace(/\\\*/g, '.*')
		.replace(/\\\?/g, '.');
	try {
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(text);
	} catch (e) {
		errorLog('Invalid GLOB pattern converted to regex: ^%s$, %O', regexPattern, e);
		return false;
	}
}

export const globFunc = createScalarFunction(
	{ name: 'glob', numArgs: 2, deterministic: true },
	(pattern: SqlValue, text: SqlValue): SqlValue => {
		if (text === null || pattern === null) return null;
		return simpleGlob(String(pattern), String(text)) ? 1 : 0;
	}
);

// --- trim(X, Y?) ---
export const trimFunc = createScalarFunction(
	{ name: 'trim', numArgs: -1, deterministic: true },
	(strVal: SqlValue, charsVal?: SqlValue): SqlValue => {
		if (strVal === null) return null;
		const str = String(strVal);
		if (charsVal === undefined || charsVal === null) {
			return str.trim();
		}
		const chars = String(charsVal);
		if (chars.length === 0) return str;

		try {
			const escapedChars = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(`^[${escapedChars}]+|[${escapedChars}]+$`, 'g');
			return str.replace(regex, '');
		} catch (e) {
			warnLog('Error creating trim regex for chars: %s, %O', chars, e);
			return str.trim();
		}
	}
);

// --- ltrim(X, Y?) ---
export const ltrimFunc = createScalarFunction(
	{ name: 'ltrim', numArgs: -1, deterministic: true },
	(strVal: SqlValue, charsVal?: SqlValue): SqlValue => {
		if (strVal === null) return null;
		const str = String(strVal);
		if (charsVal === undefined || charsVal === null) {
			return str.trimStart();
		}
		const chars = String(charsVal);
		if (chars.length === 0) return str;

		try {
			const escapedChars = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(`^[${escapedChars}]+`, 'g');
			return str.replace(regex, '');
		} catch (e) {
			warnLog('Error creating ltrim regex for chars: %s, %O', chars, e);
			return str.trimStart();
		}
	}
);

// --- rtrim(X, Y?) ---
export const rtrimFunc = createScalarFunction(
	{ name: 'rtrim', numArgs: -1, deterministic: true },
	(strVal: SqlValue, charsVal?: SqlValue): SqlValue => {
		if (strVal === null) return null;
		const str = String(strVal);
		if (charsVal === undefined || charsVal === null) {
			return str.trimEnd();
		}
		const chars = String(charsVal);
		if (chars.length === 0) return str;

		try {
			const escapedChars = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(`[${escapedChars}]+$`, 'g');
			return str.replace(regex, '');
		} catch (e) {
			warnLog('Error creating rtrim regex for chars: %s, %O', chars, e);
			return str.trimEnd();
		}
	}
);

// --- replace(X, Y, Z) ---
export const replaceFunc = createScalarFunction(
	{ name: 'replace', numArgs: 3, deterministic: true },
	(strVal: SqlValue, patternVal: SqlValue, replacementVal: SqlValue): SqlValue => {
		if (strVal === null || patternVal === null || replacementVal === null) return null;

		const str = String(strVal);
		const pattern = String(patternVal);
		const replacement = String(replacementVal);

		if (pattern === '') return str;
		return str.split(pattern).join(replacement);
	}
);

// --- instr(X, Y) ---
export const instrFunc = createScalarFunction(
	{ name: 'instr', numArgs: 2, deterministic: true },
	(strVal: SqlValue, subVal: SqlValue): SqlValue => {
		if (strVal === null || subVal === null) return 0;

		const str = String(strVal);
		const sub = String(subVal);

		if (sub.length === 0) return 0;
		if (str.length === 0) return 0;

		const index = str.indexOf(sub);
		return index === -1 ? 0 : index + 1;
	}
);

// String reverse function
export const reverseFunc = createScalarFunction(
	{ name: 'reverse', numArgs: 1, deterministic: true },
	(str: SqlValue): SqlValue => {
		if (typeof str !== 'string') return null;
		return str.split('').reverse().join('');
	}
);

// Left padding function
export const lpadFunc = createScalarFunction(
	{ name: 'lpad', numArgs: 3, deterministic: true },
	(str: SqlValue, len: SqlValue, pad: SqlValue): SqlValue => {
		if (typeof str !== 'string' || typeof len !== 'number' || typeof pad !== 'string') return null;

		const strLen = str.length;
		if (len <= strLen) return str;

		const padStr = pad.repeat(len - strLen);
		return padStr + str;
	}
);

// Right padding function
export const rpadFunc = createScalarFunction(
	{ name: 'rpad', numArgs: 3, deterministic: true },
	(str: SqlValue, len: SqlValue, pad: SqlValue): SqlValue => {
		if (typeof str !== 'string' || typeof len !== 'number' || typeof pad !== 'string') return null;

		const strLen = str.length;
		if (len <= strLen) return str;

		const padStr = pad.repeat(len - strLen);
		return str + padStr;
	}
);

// Split a string into rows (table-valued function)
export const splitStringFunc = createTableValuedFunction(
	{ name: 'split_string', numArgs: 2, deterministic: true },
	async function* (str: SqlValue, delimiter: SqlValue): AsyncIterable<Row> {
		if (typeof str !== 'string' || typeof delimiter !== 'string') return;

		const parts = str.split(delimiter);
		for (let i = 0; i < parts.length; i++) {
			yield [parts[i], i]; // value, index
		}
	}
);

// String concatenation aggregate (like GROUP_CONCAT but simpler)
export const stringConcatFunc = createAggregateFunction(
	{ name: 'string_concat', numArgs: 1, initialValue: [] },
	(acc: string[], value: SqlValue) => {
		if (typeof value === 'string') {
			acc.push(value);
		}
		return acc;
	},
	(acc: string[]) => acc.join(',')
);

