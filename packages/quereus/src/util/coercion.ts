import type { SqlValue } from '../common/types.js';

/**
 * SQL type coercion utilities.
 * Different SQL contexts have different coercion rules.
 */

/**
 * Attempts to convert a value to a number if it's a numeric string.
 * Returns the original value if conversion is not appropriate.
 * Used for comparison contexts where numeric strings should be treated as numbers.
 */
export function tryCoerceToNumber(value: SqlValue): SqlValue {
	if (typeof value === 'string' && value.trim() !== '') {
		// Try to parse as number
		const trimmed = value.trim();
		const asNumber = Number(trimmed);
		if (!isNaN(asNumber) && isFinite(asNumber)) {
			// Check if it's an integer or float
			return Number.isInteger(asNumber) ? Math.trunc(asNumber) : asNumber;
		}
	}
	return value;
}

/**
 * Converts a value to a number for arithmetic contexts.
 * Non-numeric strings become 0 (SQL arithmetic semantics).
 * Used for +, -, *, /, % operations.
 */
export function coerceToNumberForArithmetic(value: SqlValue): number {
	if (typeof value === 'number') {
		return value;
	} else if (typeof value === 'boolean') {
		return value ? 1 : 0;
	} else if (typeof value === 'string') {
		const parsed = Number(value.trim());
		return isNaN(parsed) ? 0 : parsed; // Non-numeric strings become 0
	} else {
		return 0; // Blobs, null, etc. become 0
	}
}

/**
 * Performs SQL type coercion for comparison operations.
 * If one operand is numeric and the other is text that can be converted to a number,
 * converts the text to a number before comparison.
 */
export function coerceForComparison(v1: SqlValue, v2: SqlValue): [SqlValue, SqlValue] {
	// If either value is null, no coercion needed
	if (v1 === null || v2 === null) {
		return [v1, v2];
	}

	const v1IsNumeric = typeof v1 === 'number' || typeof v1 === 'bigint' || typeof v1 === 'boolean';
	const v2IsNumeric = typeof v2 === 'number' || typeof v2 === 'bigint' || typeof v2 === 'boolean';
	const v1IsText = typeof v1 === 'string';
	const v2IsText = typeof v2 === 'string';

	// Case 1: v1 is numeric, v2 is text -> try to convert v2 to numeric
	if (v1IsNumeric && v2IsText) {
		const coercedV2 = tryCoerceToNumber(v2);
		return [v1, coercedV2];
	}

	// Case 2: v1 is text, v2 is numeric -> try to convert v1 to numeric
	if (v1IsText && v2IsNumeric) {
		const coercedV1 = tryCoerceToNumber(v1);
		return [coercedV1, v2];
	}

	// No coercion needed or possible
	return [v1, v2];
}

/**
 * Coerces a value for aggregate function arguments.
 * Most aggregate functions should accept numeric strings as numbers.
 * For COUNT, no coercion needed. For SUM/AVG, numeric strings should be converted.
 */
export function coerceForAggregate(value: SqlValue, functionName: string): SqlValue {
	// COUNT and similar functions don't need numeric coercion
	if (functionName.toUpperCase() === 'COUNT' ||
		functionName.toUpperCase() === 'GROUP_CONCAT' ||
		functionName.toUpperCase().startsWith('JSON_')) {
		return value;
	}

	// Numeric aggregates (SUM, AVG, MIN, MAX) should coerce numeric strings
	if (typeof value === 'string' && value.trim() !== '') {
		const coerced = tryCoerceToNumber(value);
		return coerced;
	}

	return value;
}

/**
 * Determines if a value should be treated as numeric in the given context.
 */
export function isNumericValue(value: SqlValue): boolean {
	if (value === null) return false;
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
		return true;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') return false;
		const asNumber = Number(trimmed);
		return !isNaN(asNumber) && isFinite(asNumber);
	}
	return false;
}
