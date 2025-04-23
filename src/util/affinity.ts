import { type SqlValue } from '../common/types';

/**
 * Attempts to parse a string as an integer according to SQLite rules.
 * Ignores leading/trailing whitespace. Stops at the first non-digit.
 * Returns null if the string doesn't represent a valid integer start.
 */
function tryParseInt(str: string): bigint | number | null {
	str = str.trim();
	if (!str) return null;
	const sign = str.startsWith('-') ? -1 : str.startsWith('+') ? 1 : 1;
	if (sign !== 1) str = str.substring(1);

	let numStr = '';
	for (let i = 0; i < str.length; i++) {
		if (str[i] >= '0' && str[i] <= '9') {
			numStr += str[i];
		} else {
			break; // Stop at first non-digit
		}
	}

	if (!numStr) return null; // No digits found

	try {
		// Use BigInt for potentially large integers
		const bigIntValue = BigInt(numStr) * BigInt(sign);
		// If it fits within safe integer range, return number, otherwise BigInt
		if (bigIntValue >= Number.MIN_SAFE_INTEGER && bigIntValue <= Number.MAX_SAFE_INTEGER) {
			return Number(bigIntValue);
		}
		return bigIntValue;
	} catch {
		return null; // Error during BigInt conversion (should be rare with the regex check)
	}
}

/**
 * Attempts to parse a string as a floating-point number.
 * Returns null if the string doesn't represent a valid number.
 * Handles Infinity and NaN correctly.
 */
function tryParseReal(str: string): number | null {
	str = str.trim();
	if (!str) return null;
	// Very basic check, rely on parseFloat but handle empty string case
	// TODO: More robust SQLite-like parsing might be needed for edge cases
	const num = parseFloat(str);
	// Check if the string *only* contained numeric-related characters initially?
	// For now, simple parseFloat is likely sufficient.
	return isNaN(num) ? null : num;
}

// --- Affinity Application Functions ---

export function applyIntegerAffinity(value: SqlValue): SqlValue {
	if (value === null || typeof value === 'bigint') return value;
	if (typeof value === 'number') {
		// SQLite rounds towards zero for REAL -> INTEGER
		const intVal = Math.trunc(value);
		// Check if still representable as JS number accurately (avoid large float conversion issues)
		if (intVal >= Number.MIN_SAFE_INTEGER && intVal <= Number.MAX_SAFE_INTEGER) {
			return intVal;
		} else {
			// Potentially too large for standard number, try BigInt, else fallback to REAL
			try {
				return BigInt(intVal); // This might still lose precision if original number was huge float
			} catch {
				return value; // Fallback to original REAL if BigInt fails
			}
		}
	}
	if (typeof value === 'string') {
		const intAttempt = tryParseInt(value);
		if (intAttempt !== null) return intAttempt;
		// If integer parse fails, check if it looks like a REAL
		const realAttempt = tryParseReal(value);
		if (realAttempt !== null) {
			// Convert the parsed REAL to INTEGER (round towards zero)
			return applyIntegerAffinity(realAttempt);
		}
		return null; // Failed to parse as INTEGER or REAL
	}
	if (value instanceof Uint8Array) {
		return null; // BLOB -> INTEGER = NULL
	}
	return value; // Boolean is handled implicitly via NUMERIC rules usually
}

export function applyRealAffinity(value: SqlValue): SqlValue {
	if (value === null) return null;
	if (typeof value === 'number' || typeof value === 'bigint') {
		return Number(value); // Convert INTEGER/BigInt to REAL (float)
	}
	if (typeof value === 'string') {
		return tryParseReal(value);
	}
	if (value instanceof Uint8Array) {
		return null; // BLOB -> REAL = NULL
	}
	return value;
}

export function applyNumericAffinity(value: SqlValue): SqlValue {
	if (value === null || typeof value === 'number' || typeof value === 'bigint') {
		return value; // No change for NULL or existing numerics
	}
	if (typeof value === 'string') {
		const intAttempt = tryParseInt(value);
		if (intAttempt !== null) return intAttempt;
		const realAttempt = tryParseReal(value);
		if (realAttempt !== null) return realAttempt;
		// If it cannot be parsed as INTEGER or REAL, keep original TEXT
		return value;
	}
	if (value instanceof Uint8Array) {
		return value; // BLOB remains BLOB for NUMERIC affinity
	}
	return value;
}

export function applyTextAffinity(value: SqlValue): SqlValue {
	if (value === null || typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'bigint') {
		return String(value);
	}
	if (value instanceof Uint8Array) {
		// How SQLite converts BLOB to TEXT is complex (depends on encoding context).
		// For simplicity, let's represent it as a hex string like `X'...'`?
		// Or just return the BLOB itself? Let's return BLOB for now.
		// return `X'${Buffer.from(value).toString('hex')}'`;
		return value; // Keep BLOB as BLOB when applying TEXT affinity
	}
	return String(value); // Catch-all (e.g., boolean)
}

export function applyBlobAffinity(value: SqlValue): SqlValue {
	// BLOB affinity is essentially a no-op in SQLite terms.
	// It doesn't convert other types *to* BLOB automatically.
	// It just stores the value as-is.
	return value;
}
