import { PhysicalType, type LogicalType, compareNulls } from './logical-type.js';
import { safeJsonParse } from '../func/builtins/json-helpers.js';
import type { JSONValue } from '../common/json-types.js';

/**
 * JSON type - stores valid JSON strings
 * Uses TEXT for physical storage but validates JSON syntax
 * Provides deep equality comparison for JSON values
 */
export const JSON_TYPE: LogicalType = {
	name: 'JSON',
	physicalType: PhysicalType.TEXT,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		// Validate that it's valid JSON
		return safeJsonParse(v) !== null;
	},

	parse: (v) => {
		if (v === null) return null;
		
		// If it's already a string, validate and normalize it
		if (typeof v === 'string') {
			const parsed = safeJsonParse(v);
			if (parsed === null) {
				throw new TypeError(`Cannot convert '${v}' to JSON: invalid JSON syntax`);
			}
			// Normalize by re-stringifying (removes whitespace, ensures consistent format)
			try {
				return JSON.stringify(parsed);
			} catch (e) {
				throw new TypeError(`Cannot convert to JSON: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// Convert other types to JSON
		if (typeof v === 'number' || typeof v === 'boolean') {
			return JSON.stringify(v);
		}

		if (typeof v === 'bigint') {
			// BigInt can't be directly serialized to JSON, convert to number
			return JSON.stringify(Number(v));
		}

		throw new TypeError(`Cannot convert ${typeof v} to JSON`);
	},

	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		// Both should be strings at this point
		if (typeof a !== 'string' || typeof b !== 'string') {
			// Fallback to string comparison
			return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
		}

		// Parse both JSON values
		const parsedA = safeJsonParse(a);
		const parsedB = safeJsonParse(b);

		// If either is invalid JSON, fall back to string comparison
		if (parsedA === null || parsedB === null) {
			return a < b ? -1 : a > b ? 1 : 0;
		}

		// Deep equality comparison
		return deepCompareJson(parsedA, parsedB);
	},

	// No collations for JSON type
	supportedCollations: [],

	// Metadata
	isNumeric: false,
	isTextual: false,
	isTemporal: false,
};

/** Ordering rank for JSON value types: null < boolean < number < string < array < object */
function jsonTypeOrder(v: JSONValue): number {
	if (v === null) return 0;
	switch (typeof v) {
		case 'boolean': return 1;
		case 'number': return 2;
		case 'string': return 3;
		default: return Array.isArray(v) ? 4 : 5;
	}
}

/**
 * Deep comparison of JSON values.
 * Returns -1, 0, or 1 for ordering.
 */
function deepCompareJson(a: JSONValue, b: JSONValue): number {
	if (a === b) return 0;

	const orderA = jsonTypeOrder(a);
	const orderB = jsonTypeOrder(b);
	if (orderA !== orderB) return orderA < orderB ? -1 : 1;

	if (a === null) return 0;

	if (typeof a === 'boolean' || typeof a === 'number' || typeof a === 'string') {
		return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
	}

	if (Array.isArray(a) && Array.isArray(b)) {
		const minLen = Math.min(a.length, b.length);
		for (let i = 0; i < minLen; i++) {
			const cmp = deepCompareJson(a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
	}

	if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
		const objA = a as Record<string, JSONValue>;
		const objB = b as Record<string, JSONValue>;
		const keysA = Object.keys(objA).sort();
		const keysB = Object.keys(objB).sort();

		const minKeys = Math.min(keysA.length, keysB.length);
		for (let i = 0; i < minKeys; i++) {
			if (keysA[i] < keysB[i]) return -1;
			if (keysA[i] > keysB[i]) return 1;
		}
		if (keysA.length !== keysB.length) return keysA.length < keysB.length ? -1 : 1;

		for (const key of keysA) {
			const cmp = deepCompareJson(objA[key], objB[key]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	}

	return 0;
}

