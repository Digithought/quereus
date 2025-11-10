import { PhysicalType, type LogicalType } from './logical-type.js';
import { safeJsonParse } from '../func/builtins/json-helpers.js';

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
		// NULL handling
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

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

/**
 * Deep comparison of JSON values
 * Returns -1, 0, or 1 for ordering
 */
function deepCompareJson(a: any, b: any): number {
	// Same reference or both null/undefined
	if (a === b) return 0;

	// Type comparison first
	const typeA = typeof a;
	const typeB = typeof b;

	if (typeA !== typeB) {
		// Order: null < boolean < number < string < array < object
		const typeOrder = { 
			'object': a === null ? 0 : Array.isArray(a) ? 4 : 5,
			'boolean': 1,
			'number': 2,
			'string': 3
		};
		const orderA = typeOrder[typeA as keyof typeof typeOrder] ?? 6;
		const orderB = typeOrder[typeB as keyof typeof typeOrder] ?? 6;
		return orderA < orderB ? -1 : 1;
	}

	// Same type comparison
	if (a === null) return 0;

	if (typeof a === 'boolean' || typeof a === 'number' || typeof a === 'string') {
		return a < b ? -1 : a > b ? 1 : 0;
	}

	if (Array.isArray(a) && Array.isArray(b)) {
		// Compare arrays element by element
		const minLen = Math.min(a.length, b.length);
		for (let i = 0; i < minLen; i++) {
			const cmp = deepCompareJson(a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		// If all elements are equal, shorter array comes first
		return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
	}

	if (typeof a === 'object' && typeof b === 'object') {
		// Compare objects by sorted keys
		const keysA = Object.keys(a).sort();
		const keysB = Object.keys(b).sort();

		// Compare key sets first
		const minKeys = Math.min(keysA.length, keysB.length);
		for (let i = 0; i < minKeys; i++) {
			if (keysA[i] < keysB[i]) return -1;
			if (keysA[i] > keysB[i]) return 1;
		}
		if (keysA.length < keysB.length) return -1;
		if (keysA.length > keysB.length) return 1;

		// Keys are the same, compare values
		for (const key of keysA) {
			const cmp = deepCompareJson(a[key], b[key]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	}

	// Fallback
	return 0;
}

