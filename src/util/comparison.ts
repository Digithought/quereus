import { type SqlValue } from '../common/types';

/**
 * Evaluates a JavaScript value according to simplified, JS-idiomatic truthiness rules.
 * - null/undefined are false.
 * - boolean is its own value.
 * - number: 0 is false, non-zero is true.
 * - bigint: 0n is false, non-zero is true.
 * - string: empty string is false, non-empty is true.
 * - Uint8Array (BLOB): always false.
 * @param value The value to evaluate.
 * @returns True or false.
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
				return false; // BLOBs are false
			}
			return false; // Other objects are false
		default:
			return false;
	}
}

/**
 * Compares two SqlValue types using JavaScript comparison rules, aiming
 * for determinism consistent with typical JS expectations. Handles nulls.
 * Order: NULL < Numbers < Strings < Blobs < Booleans (arbitrary but consistent)
 * @param a First value.
 * @param b Second value.
 * @returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareSqlValues(a: SqlValue, b: SqlValue): number {
	const typeA = getComparisonTypeOrder(a);
	const typeB = getComparisonTypeOrder(b);

	if (typeA !== typeB) {
		return typeA - typeB;
	}

	// Types are the same (or both are numbers/bigints)
	if (a === null && b === null) return 0; // Should be covered by type order, but safe

	switch (typeof a) {
		case 'number':
			// Handle potential comparison with bigint b
			if (typeof b === 'bigint') {
				const bigA = BigInt(Math.trunc(a)); // Potential precision loss for large floats
				return bigA < b ? -1 : bigA > b ? 1 : 0;
			}
			// Standard number comparison
			const numB = b as number; // Type already matched
			return a < numB ? -1 : a > numB ? 1 : 0;
		case 'bigint':
			// Handle potential comparison with number b
			if (typeof b === 'number') {
				const bigB = BigInt(Math.trunc(b));
				return a < bigB ? -1 : a > bigB ? 1 : 0;
			}
			// Standard bigint comparison
			const bigB_ = b as bigint; // Type already matched
			return a < bigB_ ? -1 : a > bigB_ ? 1 : 0;
		case 'string':
			// Simple lexicographical comparison
			const strB = b as string;
			return a < strB ? -1 : a > strB ? 1 : 0;
		case 'boolean':
			// false < true
			const boolB = b as boolean;
			return (a === boolB) ? 0 : (a === false) ? -1 : 1;
		case 'object':
			if (a instanceof Uint8Array && b instanceof Uint8Array) {
				// Lexicographical comparison of byte arrays
				const len = Math.min(a.length, b.length);
				for (let i = 0; i < len; i++) {
					if (a[i] !== b[i]) {
						return a[i] < b[i] ? -1 : 1;
					}
				}
				return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
			}
		// Fallthrough for other objects (shouldn't happen with SqlValue)
		default:
			return 0; // Treat unknown/incomparable types as equal?
	}
}

/** Assigns an order to types for comparison */
function getComparisonTypeOrder(v: SqlValue): number {
	if (v === null || v === undefined) return 0; // NULLs first
	const type = typeof v;
	if (type === 'number' || type === 'bigint') return 1; // All numerics together
	if (type === 'string') return 2;
	if (type === 'object' && v instanceof Uint8Array) return 3; // Blobs
	if (type === 'boolean') return 4; // Booleans last
	return 99; // Should not happen
}

// TODO: Add comparison functions (compareSqlValues) that implement
// SQLite's type comparison rules and collations. This is complex.
