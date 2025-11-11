import { PhysicalType, type LogicalType } from './logical-type.js';

/**
 * NULL type - represents null values
 */
export const NULL_TYPE: LogicalType = {
	name: 'NULL',
	physicalType: PhysicalType.NULL,

	validate: (v) => v === null,

	compare: (a, b) => {
		// Both must be null
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;
		return 0;
	},
};

/**
 * INTEGER type - whole numbers
 */
export const INTEGER_TYPE: LogicalType = {
	name: 'INTEGER',
	physicalType: PhysicalType.INTEGER,
	isNumeric: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v === 'bigint') return true;
		if (typeof v === 'number') return Number.isInteger(v) && Number.isSafeInteger(v);
		return false;
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'bigint') return v;
		if (typeof v === 'number') {
			if (!Number.isInteger(v)) {
				return Math.trunc(v);
			}
			return v;
		}
		if (typeof v === 'boolean') return v ? 1 : 0;
		if (typeof v === 'string') {
			const trimmed = v.trim();
			if (trimmed === '') return null;
			const parsed = parseInt(trimmed, 10);
			if (isNaN(parsed)) {
				throw new TypeError(`Cannot convert '${v}' to INTEGER`);
			}
			return parsed;
		}
		throw new TypeError(`Cannot convert ${typeof v} to INTEGER`);
	},

	compare: (a, b) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

		const numA = typeof a === 'bigint' ? Number(a) : a as number;
		const numB = typeof b === 'bigint' ? Number(b) : b as number;

		return numA < numB ? -1 : numA > numB ? 1 : 0;
	},
};

/**
 * REAL type - floating point numbers
 */
export const REAL_TYPE: LogicalType = {
	name: 'REAL',
	physicalType: PhysicalType.REAL,
	isNumeric: true,

	validate: (v) => {
		if (v === null) return true;
		return typeof v === 'number';
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'number') return v;
		if (typeof v === 'bigint') return Number(v);
		if (typeof v === 'boolean') return v ? 1.0 : 0.0;
		if (typeof v === 'string') {
			const trimmed = v.trim();
			if (trimmed === '') return null;
			const parsed = parseFloat(trimmed);
			if (isNaN(parsed)) {
				throw new TypeError(`Cannot convert '${v}' to REAL`);
			}
			return parsed;
		}
		throw new TypeError(`Cannot convert ${typeof v} to REAL`);
	},

	compare: (a, b) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

		const numA = a as number;
		const numB = b as number;

		// Handle NaN
		if (isNaN(numA) && isNaN(numB)) return 0;
		if (isNaN(numA)) return -1;
		if (isNaN(numB)) return 1;

		return numA < numB ? -1 : numA > numB ? 1 : 0;
	},
};

/**
 * TEXT type - strings
 */
export const TEXT_TYPE: LogicalType = {
	name: 'TEXT',
	physicalType: PhysicalType.TEXT,
	isTextual: true,
	supportedCollations: ['BINARY', 'NOCASE', 'RTRIM'],

	validate: (v) => {
		if (v === null) return true;
		return typeof v === 'string';
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'string') return v;
		if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
			return String(v);
		}
		if (v instanceof Uint8Array) {
			// Convert blob to hex string
			return Array.from(v)
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		}
		throw new TypeError(`Cannot convert ${typeof v} to TEXT`);
	},

	compare: (a, b, collation) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

		const strA = a as string;
		const strB = b as string;

		if (collation) {
			return collation(strA, strB);
		}

		// Default binary comparison
		return strA < strB ? -1 : strA > strB ? 1 : 0;
	},
};

/**
 * BLOB type - binary data
 */
export const BLOB_TYPE: LogicalType = {
	name: 'BLOB',
	physicalType: PhysicalType.BLOB,

	validate: (v) => {
		if (v === null) return true;
		return v instanceof Uint8Array;
	},

	parse: (v) => {
		if (v === null) return null;
		if (v instanceof Uint8Array) return v;
		if (typeof v === 'string') {
			// Check if it's a hex string (even length, all hex chars)
			if (v.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(v) && v.length > 0) {
				// Convert hex string to blob
				const bytes = new Uint8Array(v.length / 2);
				for (let i = 0; i < v.length; i += 2) {
					bytes[i / 2] = parseInt(v.substr(i, 2), 16);
				}
				return bytes;
			}
			// For non-hex strings, convert to UTF-8 bytes
			const encoder = new TextEncoder();
			return encoder.encode(v);
		}
		if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
			// Convert to string first, then to UTF-8 bytes
			const encoder = new TextEncoder();
			return encoder.encode(String(v));
		}
		throw new TypeError(`Cannot convert ${typeof v} to BLOB`);
	},

	compare: (a, b) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

		const blobA = a as Uint8Array;
		const blobB = b as Uint8Array;

		const minLen = Math.min(blobA.length, blobB.length);
		for (let i = 0; i < minLen; i++) {
			if (blobA[i] !== blobB[i]) {
				return blobA[i] < blobB[i] ? -1 : 1;
			}
		}

		return blobA.length - blobB.length;
	},
};

/**
 * BOOLEAN type - true/false values
 */
export const BOOLEAN_TYPE: LogicalType = {
	name: 'BOOLEAN',
	physicalType: PhysicalType.BOOLEAN,

	validate: (v) => {
		if (v === null) return true;
		return typeof v === 'boolean';
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'boolean') return v;
		if (typeof v === 'number' || typeof v === 'bigint') {
			return v !== 0;
		}
		if (typeof v === 'string') {
			const lower = v.toLowerCase().trim();
			if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
			if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
			throw new TypeError(`Cannot convert '${v}' to BOOLEAN`);
		}
		throw new TypeError(`Cannot convert ${typeof v} to BOOLEAN`);
	},

	compare: (a, b) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

		const boolA = a as boolean;
		const boolB = b as boolean;

		// false < true
		if (boolA === boolB) return 0;
		return boolA ? 1 : -1;
	},
};

/**
 * NUMERIC type - for backward compatibility with SQLite's NUMERIC affinity
 * Tries to store as INTEGER if possible, otherwise REAL
 */
export const NUMERIC_TYPE: LogicalType = {
	name: 'NUMERIC',
	physicalType: PhysicalType.REAL,
	isNumeric: true,

	validate: (v) => {
		if (v === null) return true;
		return typeof v === 'number' || typeof v === 'bigint';
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'number' || typeof v === 'bigint') return v;
		if (typeof v === 'boolean') return v ? 1 : 0;
		if (typeof v === 'string') {
			const trimmed = v.trim();
			if (trimmed === '') return null;

			// Try integer first
			if (/^-?\d+$/.test(trimmed)) {
				const parsed = parseInt(trimmed, 10);
				if (!isNaN(parsed)) return parsed;
			}

			// Fall back to real
			const parsed = parseFloat(trimmed);
			if (isNaN(parsed)) {
				throw new TypeError(`Cannot convert '${v}' to NUMERIC`);
			}
			return parsed;
		}
		throw new TypeError(`Cannot convert ${typeof v} to NUMERIC`);
	},

	compare: (a, b) => {
		// Use REAL comparison
		return REAL_TYPE.compare!(a, b);
	},
};

/**
 * ANY type - accepts any value without conversion
 * Useful for dynamic data or when type is truly unknown
 * Note: Uses NULL as physical type since it can represent any type
 */
export const ANY_TYPE: LogicalType = {
	name: 'ANY',
	physicalType: PhysicalType.NULL,

	validate: () => true, // Accept any value

	parse: (v) => v, // No conversion, store as-is

	compare: (a, b) => {
		// Follow SQLite comparison rules: NULL < NUMERIC < TEXT < BLOB
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

		// Determine storage classes following SQLite rules
		const getStorageClass = (v: any): number => {
			const type = typeof v;
			if (type === 'number' || type === 'bigint' || type === 'boolean') return 1; // NUMERIC
			if (type === 'string') return 2; // TEXT
			if (type === 'object' && v instanceof Uint8Array) return 3; // BLOB
			return 4; // UNKNOWN
		};

		const classA = getStorageClass(a);
		const classB = getStorageClass(b);

		// Different storage classes: compare by class
		if (classA !== classB) {
			return classA < classB ? -1 : 1;
		}

		// Same storage class: compare values
		// For booleans, convert to numbers (false=0, true=1)
		const valA = typeof a === 'boolean' ? (a ? 1 : 0) : a;
		const valB = typeof b === 'boolean' ? (b ? 1 : 0) : b;

		if (valA < valB) return -1;
		if (valA > valB) return 1;
		return 0;
	},
};

