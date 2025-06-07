import type { Row, SqlValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('util:comparison');
const warnLog = log.extend('warn');

/**
 * Function type for SQLite collation functions.
 * Takes two strings and returns a comparison result (-1, 0, 1)
 */
export type CollationFunction = (a: string, b: string) => number;

// Map to store registered collations
const collations = new Map<string, CollationFunction>();

/**
 * Binary (default) collation function.
 * Performs standard lexicographical comparison of strings.
 */
export const BINARY_COLLATION: CollationFunction = (a, b) => {
	return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Case-insensitive collation function.
 * Compares strings after converting them to lowercase.
 */
export const NOCASE_COLLATION: CollationFunction = (a, b) => {
	const lowerA = a.toLowerCase();
	const lowerB = b.toLowerCase();
	return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : 0;
};

/**
 * Right-trim collation function.
 * Compares strings after removing trailing spaces.
 */
export const RTRIM_COLLATION: CollationFunction = (a, b) => {
	let lenA = a.length;
	let lenB = b.length;

	while (lenA > 0 && a[lenA - 1] === ' ') lenA--;
	while (lenB > 0 && b[lenB - 1] === ' ') lenB--;

	const minLen = Math.min(lenA, lenB);
	for (let i = 0; i < minLen; i++) {
		if (a[i] !== b[i]) {
			return a[i] < b[i] ? -1 : 1;
		}
	}

	return lenA - lenB;
};

/**
 * Registers a collation function with the given name.
 * @param name The name of the collation (case-insensitive)
 * @param func The collation function to register
 */
export function registerCollation(name: string, func: CollationFunction): void {
    const upperName = name.toUpperCase();
    if (collations.has(upperName)) {
        warnLog(`Overwriting existing collation: %s`, upperName);
    }
    collations.set(upperName, func);
}

/**
 * Gets a registered collation function by name.
 * @param name The collation name (case-insensitive)
 * @returns The collation function, or undefined if not found
 */
export function getCollation(name: string): CollationFunction | undefined {
	return collations.get(name.toUpperCase());
}

/**
 * Evaluates a JavaScript value according to simplified, JS-idiomatic truthiness rules.
 * - null/undefined are false
 * - boolean is its own value
 * - number: 0 is false, non-zero is true
 * - bigint: 0n is false, non-zero is true
 * - string: empty string is false, non-empty is true
 * - Uint8Array (BLOB): always false
 *
 * @param value The value to evaluate
 * @returns True or false
 */
export function evaluateIsTrue(value: SqlValue): boolean {
	if (value === null || value === undefined) {
		return false;
	}
	switch (typeof value) {
		case 'boolean':
			return value;
		case 'number':
			return value !== 0;
		case 'bigint':
			return value !== 0n;
		case 'string':
			return value.length > 0;
		case 'object':
			if (value instanceof Uint8Array) {
				return false;
			}
			return false;
		default:
			return false;
	}
}

/** Represents SQLite storage classes for comparison purposes */
enum StorageClass {
	NULL = 0,
	NUMERIC = 1, // INTEGER or REAL
	TEXT = 2,
	BLOB = 3,
	UNKNOWN = 99
}

/** Determines the effective storage class for comparison, converting boolean to numeric */
function getStorageClass(v: SqlValue): StorageClass {
	if (v === null || v === undefined) return StorageClass.NULL;
	const type = typeof v;
	if (type === 'number' || type === 'bigint' || type === 'boolean') return StorageClass.NUMERIC;
	if (type === 'string') return StorageClass.TEXT;
	if (type === 'object' && v instanceof Uint8Array) return StorageClass.BLOB;
	return StorageClass.UNKNOWN;
}

/**
 * Returns the SQLite fundamental datatype name of a value.
 * @param v The value
 * @returns The datatype name as a string
 */
export function getSqlDataTypeName(v: SqlValue): 'null' | 'integer' | 'real' | 'text' | 'blob' {
	if (v === null || v === undefined) return 'null';
	const type = typeof v;
	if (type === 'boolean') return 'integer';
	if (type === 'number') {
		return Number.isInteger(v) ? 'integer' : 'real';
	}
	if (type === 'bigint') return 'integer';
	if (type === 'string') return 'text';
	if (type === 'object' && v instanceof Uint8Array) return 'blob';
	return 'null';
}

/**
 * Compares two SQLite values based on SQLite's comparison rules.
 * Follows SQLite's type ordering: NULL < Numeric < TEXT < BLOB
 *
 * @param a First value
 * @param b Second value
 * @param collationName The collation to use for text comparison (defaults to BINARY)
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSqlValues(a: SqlValue, b: SqlValue, collationName: string = 'BINARY'): number {
	const classA = getStorageClass(a);
	const classB = getStorageClass(b);

	if (classA === StorageClass.NULL && classB === StorageClass.NULL) return 0;
	if (classA === StorageClass.NULL) return -1;
	if (classB === StorageClass.NULL) return 1;

	if (classA !== classB) {
		return classA - classB;
	}

	// Convert booleans to numbers for consistent comparison
	const valA = typeof a === 'boolean' ? (a ? 1 : 0) : a;
	const valB = typeof b === 'boolean' ? (b ? 1 : 0) : b;

	switch (classA) {
		case StorageClass.NUMERIC: {
			return (valA as number | bigint) < (valB as number | bigint) ? -1 :
			       (valA as number | bigint) > (valB as number | bigint) ? 1 : 0;
		}
		case StorageClass.TEXT: {
            const collationFunc = collations.get(collationName.toUpperCase());
            if (!collationFunc) {
                warnLog(`Unknown collation requested: %s. Falling back to BINARY.`, collationName);
                return BINARY_COLLATION(valA as string, valB as string);
            }
            return collationFunc(valA as string, valB as string);
		}
		case StorageClass.BLOB: {
			const blobA = valA as Uint8Array;
			const blobB = valB as Uint8Array;
			const len = Math.min(blobA.length, blobB.length);
			for (let i = 0; i < len; i++) {
				if (blobA[i] !== blobB[i]) {
					return blobA[i] < blobB[i] ? -1 : 1;
				}
			}
			return blobA.length < blobB.length ? -1 : blobA.length > blobB.length ? 1 : 0;
		}
		default: {
			return 0;
		}
	}
}

/**
 * Determines if a SqlValue is truthy for filter purposes.
 * In SQL semantics:
 * - NULL is falsy
 * - 0 (number) is falsy
 * - Empty string is falsy
 * - false (boolean) is falsy
 * - Everything else is truthy
 */
export function isTruthy(value: SqlValue): boolean {
	return (typeof value === 'string') ? value.length > 0 : !!value;
}
/**
 * Compares two rows for SQL DISTINCT semantics.
 * Returns -1, 0, or 1 for BTree ordering.
 */
export function compareRows(a: Row, b: Row): number {
	// Let's assume correct rows
	// if (a.length !== b.length) {
	// 	return a.length - b.length;
	// }
	// Compare each value using SQL semantics
	for (let i = 0; i < a.length; i++) {
		const comparison = compareSqlValues(a[i], b[i]);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return 0;
}

// TODO: The main remaining task for comparison is implementing SQLite's
// type affinity rules (which affect how values are treated BEFORE comparison)
// and handling different TEXT collations.
