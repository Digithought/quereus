import { StatusCode } from "../../common/types.js";
import { QuereusError } from "../../common/errors.js";
import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { BinaryOpNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import type { EmissionContext } from "../emission-context.js";
import { Temporal } from 'temporal-polyfill';
import { TIMESPAN_TYPE } from "../../types/temporal-types.js";

/**
 * Check if a value is a date string (YYYY-MM-DD format)
 */
function isDateValue(v: SqlValue): boolean {
	if (typeof v !== 'string') return false;
	// Simple check for ISO 8601 date format
	return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Check if a value is a time string (HH:MM:SS format)
 */
function isTimeValue(v: SqlValue): boolean {
	if (typeof v !== 'string') return false;
	// Simple check for ISO 8601 time format
	return /^\d{2}:\d{2}:\d{2}/.test(v);
}

/**
 * Check if a value is a datetime string (ISO 8601 format)
 */
function isDateTimeValue(v: SqlValue): boolean {
	if (typeof v !== 'string') return false;
	// Check for ISO 8601 datetime format (with T separator)
	return v.includes('T') && /^\d{4}-\d{2}-\d{2}T/.test(v);
}

/**
 * Check if a value is a timespan/duration string (ISO 8601 duration format)
 */
function isTimespanValue(v: SqlValue): boolean {
	if (typeof v !== 'string') return false;
	// ISO 8601 duration starts with P (or -P for negative)
	return v.startsWith('P') || v.startsWith('-P');
}

/**
 * Try to perform temporal arithmetic on two values.
 * Returns the result if successful, or undefined if the values are not temporal types.
 * Throws QuereusError if the operation is invalid.
 */
export function tryTemporalArithmetic(operator: string, v1: SqlValue, v2: SqlValue): SqlValue | undefined {
		if (v1 === null || v2 === null) return null;

		// Detect types at runtime
		const isV1Date = isDateValue(v1);
		const isV1Time = isTimeValue(v1);
		const isV1DateTime = isDateTimeValue(v1);
		const isV1Timespan = isTimespanValue(v1);

		const isV2Date = isDateValue(v2);
		const isV2Time = isTimeValue(v2);
		const isV2DateTime = isDateTimeValue(v2);
		const isV2Timespan = isTimespanValue(v2);

		// If neither operand is temporal, return undefined to signal non-temporal operation
		const isV1Temporal = isV1Date || isV1Time || isV1DateTime || isV1Timespan;
		const isV2Temporal = isV2Date || isV2Time || isV2DateTime || isV2Timespan;
		if (!isV1Temporal && !isV2Temporal) {
			return undefined;
		}

		try {

			// DATE/DATETIME - DATE/DATETIME → TIMESPAN
			if (operator === '-' &&
				(isV1Date || isV1DateTime) &&
				(isV2Date || isV2DateTime)) {

				// Parse both values as dates
				const date1 = isV1DateTime
					? Temporal.PlainDateTime.from(v1 as string).toPlainDate()
					: Temporal.PlainDate.from(v1 as string);
				const date2 = isV2DateTime
					? Temporal.PlainDateTime.from(v2 as string).toPlainDate()
					: Temporal.PlainDate.from(v2 as string);

				const duration = date1.since(date2);
				return duration.toString();
			}

			// TIME - TIME → TIMESPAN
			if (operator === '-' && isV1Time && isV2Time) {
				const time1 = Temporal.PlainTime.from(v1 as string);
				const time2 = Temporal.PlainTime.from(v2 as string);
				const duration = time1.since(time2);
				return duration.toString();
			}

			// DATE + TIMESPAN → DATE
			if (operator === '+' && isV1Date && isV2Timespan) {
				const date = Temporal.PlainDate.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = date.add(duration);
				return result.toString();
			}

			// TIMESPAN + DATE → DATE (commutative)
			if (operator === '+' && isV1Timespan && isV2Date) {
				const duration = Temporal.Duration.from(v1 as string);
				const date = Temporal.PlainDate.from(v2 as string);
				const result = date.add(duration);
				return result.toString();
			}

			// DATE - TIMESPAN → DATE
			if (operator === '-' && isV1Date && isV2Timespan) {
				const date = Temporal.PlainDate.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = date.subtract(duration);
				return result.toString();
			}

			// DATETIME + TIMESPAN → DATETIME
			if (operator === '+' && isV1DateTime && isV2Timespan) {
				const dt = Temporal.PlainDateTime.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = dt.add(duration);
				return result.toString();
			}

			// TIMESPAN + DATETIME → DATETIME (commutative)
			if (operator === '+' && isV1Timespan && isV2DateTime) {
				const duration = Temporal.Duration.from(v1 as string);
				const dt = Temporal.PlainDateTime.from(v2 as string);
				const result = dt.add(duration);
				return result.toString();
			}

			// DATETIME - TIMESPAN → DATETIME
			if (operator === '-' && isV1DateTime && isV2Timespan) {
				const dt = Temporal.PlainDateTime.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = dt.subtract(duration);
				return result.toString();
			}

			// TIME + TIMESPAN → TIME
			if (operator === '+' && isV1Time && isV2Timespan) {
				const time = Temporal.PlainTime.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = time.add(duration);
				return result.toString();
			}

			// TIMESPAN + TIME → TIME (commutative)
			if (operator === '+' && isV1Timespan && isV2Time) {
				const duration = Temporal.Duration.from(v1 as string);
				const time = Temporal.PlainTime.from(v2 as string);
				const result = time.add(duration);
				return result.toString();
			}

			// TIME - TIMESPAN → TIME
			if (operator === '-' && isV1Time && isV2Timespan) {
				const time = Temporal.PlainTime.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = time.subtract(duration);
				return result.toString();
			}

			// TIMESPAN + TIMESPAN → TIMESPAN
			if (operator === '+' && isV1Timespan && isV2Timespan) {
				const d1 = Temporal.Duration.from(v1 as string);
				const d2 = Temporal.Duration.from(v2 as string);
				const result = d1.add(d2);
				return result.toString();
			}

			// TIMESPAN - TIMESPAN → TIMESPAN
			if (operator === '-' && isV1Timespan && isV2Timespan) {
				const d1 = Temporal.Duration.from(v1 as string);
				const d2 = Temporal.Duration.from(v2 as string);
				const result = d1.subtract(d2);
				return result.toString();
			}

			// TIMESPAN * NUMBER → TIMESPAN
			if (operator === '*' && isV1Timespan && typeof v2 === 'number') {
				const duration = Temporal.Duration.from(v1 as string);
				// Convert to seconds, multiply, convert back
				const totalSeconds = duration.total({ unit: 'seconds' });
				const newDuration = Temporal.Duration.from({ seconds: totalSeconds * v2 });
				return newDuration.toString();
			}

			// NUMBER * TIMESPAN → TIMESPAN (commutative)
			if (operator === '*' && typeof v1 === 'number' && isV2Timespan) {
				const duration = Temporal.Duration.from(v2 as string);
				const totalSeconds = duration.total({ unit: 'seconds' });
				const newDuration = Temporal.Duration.from({ seconds: totalSeconds * v1 });
				return newDuration.toString();
			}

			// TIMESPAN / NUMBER → TIMESPAN
			if (operator === '/' && isV1Timespan && typeof v2 === 'number') {
				if (v2 === 0) return null;
				const duration = Temporal.Duration.from(v1 as string);
				const totalSeconds = duration.total({ unit: 'seconds' });
				const newDuration = Temporal.Duration.from({ seconds: totalSeconds / v2 });
				return newDuration.toString();
			}

			// TIMESPAN / TIMESPAN → NUMBER (ratio)
			if (operator === '/' && isV1Timespan && isV2Timespan) {
				const d1 = Temporal.Duration.from(v1 as string);
				const d2 = Temporal.Duration.from(v2 as string);
				const total1 = d1.total({ unit: 'seconds' });
				const total2 = d2.total({ unit: 'seconds' });
				if (total2 === 0) return null;
				return total1 / total2;
			}

			// If we get here, the operation is not supported
			throw new QuereusError(
				`Unsupported temporal operation`,
				StatusCode.UNSUPPORTED
			);
		} catch (e) {
			// Invalid temporal operation - return null
			if (e instanceof QuereusError) throw e;
			return null;
		}
}

/**
 * Emit temporal arithmetic operations
 * Handles operations between temporal types (DATE, TIME, DATETIME, TIMESPAN)
 */
export function emitTemporalArithmetic(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	const operator = plan.expression.operator;

	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		return tryTemporalArithmetic(operator, v1, v2) ?? null;
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: run as InstructionRun,
		note: `${operator}(temporal)`
	};
}

/**
 * Attempts to perform temporal comparison. Returns undefined if not a temporal comparison.
 * This allows the caller to fall back to standard comparison logic.
 *
 * Temporal types that need special comparison logic (beyond lexicographic string comparison):
 * - TIMESPAN: Durations need to be compared semantically, not lexicographically
 *   (e.g., "PT30M" > "PT1H" lexicographically, but 30 minutes < 1 hour semantically)
 *
 * Note: DATE, TIME, and DATETIME use ISO 8601 format which compares correctly lexicographically,
 * so they don't need special handling here.
 *
 * @param operator The comparison operator (=, !=, <, <=, >, >=)
 * @param v1 First value
 * @param v2 Second value
 * @returns Comparison result (boolean) if temporal comparison, undefined otherwise
 */
export function tryTemporalComparison(operator: string, v1: SqlValue, v2: SqlValue): SqlValue | undefined {
	// Check if both values are timespans
	// Timespans are the only temporal type that needs special comparison logic
	// because ISO 8601 duration strings don't compare correctly lexicographically
	if (!isTimespanValue(v1) || !isTimespanValue(v2)) {
		return undefined;
	}

	// Use the TIMESPAN_TYPE's compare function
	const cmp = TIMESPAN_TYPE.compare!(v1, v2);

	switch (operator) {
		case '=':
		case '==':
			return cmp === 0;
		case '!=':
		case '<>':
			return cmp !== 0;
		case '<':
			return cmp < 0;
		case '<=':
			return cmp <= 0;
		case '>':
			return cmp > 0;
		case '>=':
			return cmp >= 0;
		default:
			return undefined;
	}
}
