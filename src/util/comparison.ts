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

/** Represents SQLite storage classes for comparison purposes. */
enum StorageClass {
	NULL = 0,
	NUMERIC = 1, // INTEGER or REAL
	TEXT = 2,
	BLOB = 3,
	UNKNOWN = 99
}

/** Determines the effective storage class for comparison, converting boolean to numeric. */
function getStorageClass(v: SqlValue): StorageClass {
	if (v === null || v === undefined) return StorageClass.NULL;
	const type = typeof v;
	if (type === 'number' || type === 'bigint' || type === 'boolean') return StorageClass.NUMERIC;
	if (type === 'string') return StorageClass.TEXT;
	if (type === 'object' && v instanceof Uint8Array) return StorageClass.BLOB;
	return StorageClass.UNKNOWN; // Should not happen with SqlValue
}

/**
 * Compares two SqlValue types based on SQLite's comparison rules for storage classes.
 * Order: NULL < Numeric (INTEGER/REAL/BOOLEAN) < TEXT < BLOB.
 * Note: This does not implement full SQLite type affinity rules which might apply
 * before comparison, nor does it handle collations beyond basic lexicographical for TEXT.
 * @param a First value.
 * @param b Second value.
 * @returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareSqlValues(a: SqlValue, b: SqlValue): number {
	const classA = getStorageClass(a);
	const classB = getStorageClass(b);

	if (classA === StorageClass.NULL && classB === StorageClass.NULL) return 0;
	if (classA === StorageClass.NULL) return -1; // null < non-null
	if (classB === StorageClass.NULL) return 1; // non-null > null

	if (classA !== classB) {
		return classA - classB; // Compare based on storage class order
	}

	// --- Values are of the same storage class ---

	// Convert booleans to numbers for consistent comparison within NUMERIC class
	const valA = typeof a === 'boolean' ? (a ? 1 : 0) : a;
	const valB = typeof b === 'boolean' ? (b ? 1 : 0) : b;

	switch (classA) {
		case StorageClass.NUMERIC:
			// JS comparison operators handle number/bigint comparison correctly
			return (valA as number | bigint) < (valB as number | bigint) ? -1 :
			       (valA as number | bigint) > (valB as number | bigint) ? 1 : 0;

		case StorageClass.TEXT:
			// Simple lexicographical comparison (no collation awareness)
			const strA = valA as string;
			const strB = valB as string;
			return strA < strB ? -1 : strA > strB ? 1 : 0;

		case StorageClass.BLOB:
			// Lexicographical comparison of byte arrays
			const blobA = valA as Uint8Array;
			const blobB = valB as Uint8Array;
			const len = Math.min(blobA.length, blobB.length);
			for (let i = 0; i < len; i++) {
				if (blobA[i] !== blobB[i]) {
					return blobA[i] < blobB[i] ? -1 : 1;
				}
			}
			return blobA.length < blobB.length ? -1 : blobA.length > blobB.length ? 1 : 0;

		default: // UNKNOWN - should not happen
			return 0;
	}
}

// TODO: The main remaining task for comparison is implementing SQLite's
// type affinity rules (which affect how values are treated BEFORE comparison)
// and handling different TEXT collations.
