import { FunctionFlags } from '../../common/constants';
import { SqliteError } from '../../common/errors';
import type { SqlValue } from '../../common/types';
import { createScalarFunction } from '../registration';
import { Temporal } from 'temporal-polyfill';

// --- Constants ---
const MILLIS_PER_DAY = 86400000;
const JULIAN_DAY_UNIX_EPOCH = 2440587.5;
const SQLITE_DEFAULT_DATE = { year: 2000, month: 1, day: 1 }; // Used for time-only inputs

// --- Parsing Helper (using Temporal) --- //

/**
 * Parses various date/time string formats, Julian day numbers, or Unix timestamps
 * into a Temporal object. Tries to mimic SQLite's lenient parsing.
 * @param timeVal The input value (string, number, null).
 * @param isUnixEpoch Flag indicating if the input number should be treated as Unix epoch seconds.
 * @returns A Temporal.ZonedDateTime (usually UTC) or null if parsing fails.
 */
function parseToTemporal(timeVal: SqlValue, isUnixEpoch = false): Temporal.ZonedDateTime | null {
	if (timeVal === null || timeVal === undefined) return null;

	try {
		if (typeof timeVal === 'number') {
			if (isUnixEpoch) {
				// Assume Unix timestamp in seconds, convert to Instant using milliseconds
				const instant = Temporal.Instant.fromEpochMilliseconds(timeVal * 1000);
				return instant.toZonedDateTimeISO('UTC');
			} else {
				// Check if it looks like a Julian day number
				if (timeVal > 1000000 && timeVal < 4000000) { // Heuristic for JD
					const epochMillis = (timeVal - JULIAN_DAY_UNIX_EPOCH) * MILLIS_PER_DAY;
					const instant = Temporal.Instant.fromEpochMilliseconds(epochMillis);
					return instant.toZonedDateTimeISO('UTC');
				} else {
					// Try interpreting as Unix timestamp (seconds or milliseconds) - prioritize seconds if reasonable
					try {
						// Reasonable range check for seconds (approx 1900-3000 AD)
						if (timeVal > -2208988800 && timeVal < 32503680000) {
							// Use fromEpochMilliseconds for seconds as fromEpochSeconds might not be in polyfill types
							const instant = Temporal.Instant.fromEpochMilliseconds(timeVal * 1000);
							return instant.toZonedDateTimeISO('UTC');
						}
					} catch {}
					// Try milliseconds if seconds failed or out of range
					try {
						// Reasonable range check for milliseconds (approx 1900-3000 AD)
						if (timeVal > -2208988800000 && timeVal < 32503680000000) {
							const instant = Temporal.Instant.fromEpochMilliseconds(timeVal);
							return instant.toZonedDateTimeISO('UTC');
						}
					} catch {}
					return null; // Unrecognized number format
				}
			}
		}

		if (typeof timeVal !== 'string') return null;

		const trimmedVal = timeVal.trim();
		const lowerTrimmedVal = trimmedVal.toLowerCase();

		if (lowerTrimmedVal === 'now') {
			// 'now' typically means the current time in the local timezone in SQL contexts
			return Temporal.Now.zonedDateTimeISO();
		}

		// Attempt direct parsing with Temporal.ZonedDateTime (ISO format with timezone)
		try {
			if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmedVal)) {
				const instant = Temporal.Instant.from(trimmedVal.replace(' ','T') + 'Z');
				return instant.toZonedDateTimeISO('UTC');
			}
			const zdt = Temporal.ZonedDateTime.from(trimmedVal);
			return zdt;
		} catch {}

		// Attempt direct parsing with Temporal.PlainDateTime (ISO format without timezone)
		try {
			const pdt = Temporal.PlainDateTime.from(trimmedVal.replace(' ','T'));
			return pdt.toZonedDateTime('UTC');
		} catch {}

		// Attempt direct parsing with Temporal.PlainDate (YYYY-MM-DD)
		try {
			const pd = Temporal.PlainDate.from(trimmedVal);
			return pd.toZonedDateTime('UTC'); // Defaults to 00:00:00 UTC
		} catch {}

		// Attempt direct parsing with Temporal.PlainTime (HH:MM:SS.SSS)
		try {
			const pt = Temporal.PlainTime.from(trimmedVal);
			// If only time, assume default date (2000-01-01) and UTC
			// Access individual properties instead of getISOFields
			return Temporal.PlainDateTime.from({
				...SQLITE_DEFAULT_DATE,
				hour: pt.hour,
				minute: pt.minute,
				second: pt.second,
				millisecond: pt.millisecond,
				microsecond: pt.microsecond,
				nanosecond: pt.nanosecond,
			 }).toZonedDateTime('UTC');
		} catch {}

		// --- Fallback Manual Parsing for SQLite Lenient Formats ---

		// YYYYMMDD
		let match = trimmedVal.match(/^(\d{4})(\d{2})(\d{2})$/);
		if (match) {
			const pdt = Temporal.PlainDateTime.from({ year: parseInt(match[1]), month: parseInt(match[2]), day: parseInt(match[3])});
			return pdt.toZonedDateTime('UTC');
		}

		// HH:MM
		match = trimmedVal.match(/^(\d{2}):(\d{2})$/);
		if (match) {
			const ptArgs = { hour: parseInt(match[1]), minute: parseInt(match[2]) };
			return Temporal.PlainDateTime.from({ ...SQLITE_DEFAULT_DATE, ...ptArgs }).toZonedDateTime('UTC');
		}

		// HH:MM:SS
		match = trimmedVal.match(/^(\d{2}):(\d{2}):(\d{2})$/);
		if (match) {
			const ptArgs = { hour: parseInt(match[1]), minute: parseInt(match[2]), second: parseInt(match[3]) };
			return Temporal.PlainDateTime.from({ ...SQLITE_DEFAULT_DATE, ...ptArgs }).toZonedDateTime('UTC');
		}

		// HH:MM:SS.SSS (handle varying ms digits)
		match = trimmedVal.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{1,9})$/);
		if (match) {
			const ns = parseInt(match[4].padEnd(9, '0').substring(0, 9)); // Pad/truncate to nanoseconds
			const ptArgs = {
				hour: parseInt(match[1]),
				minute: parseInt(match[2]),
				second: parseInt(match[3]),
				millisecond: Math.floor(ns / 1_000_000),
				microsecond: Math.floor((ns % 1_000_000) / 1_000),
				nanosecond: ns % 1_000,
			};
			return Temporal.PlainDateTime.from({ ...SQLITE_DEFAULT_DATE, ...ptArgs }).toZonedDateTime('UTC');
		}

		console.warn(`Failed to parse date/time string with Temporal: ${timeVal}`);
		return null;

	} catch (e) {
		console.warn(`Error parsing date/time value "${timeVal}":`, e);
		return null;
	}
}

// --- Modifier Application (using Temporal) --- //

// Regex to parse relative time modifiers like '+1 day', '-3 months'
const RELATIVE_MODIFIER_REGEX = /^\s*([+-]?\s*\d+(\.\d+)?)\s+(day|hour|minute|second|month|year)s?\s*$/i;
// Regex for 'weekday N'
const WEEKDAY_MODIFIER_REGEX = /^\s*weekday\s+([0-6])\s*$/i; // 0=Sun, 1=Mon..6=Sat

function applyTemporalModifier(dt: Temporal.ZonedDateTime, modifier: string): Temporal.ZonedDateTime {
	const trimmedModifier = modifier.trim().toLowerCase();

	// Group 1: Relative Time Shifts
	const relativeMatch = trimmedModifier.match(RELATIVE_MODIFIER_REGEX);
	if (relativeMatch) {
		const valueStr = relativeMatch[1].replace(/\s/g, '');
		const value = parseFloat(valueStr);
		const unit = relativeMatch[3]; // unit is guaranteed to be a string here

		if (isNaN(value)) {
			throw new Error(`Invalid number in modifier: ${modifier}`);
		}

		// Use Record<string, number> for better type checking with dynamic keys
		const durationLike: Record<string, number> = {};
		if (unit === 'year' || unit === 'month' || unit === 'day') {
			durationLike[`${unit}s`] = Math.trunc(value);
		} else if (unit === 'hour' || unit === 'minute' || unit === 'second') {
			if (unit === 'second') {
				const seconds = Math.trunc(value);
				const nanoseconds = Math.round((value % 1) * 1e9);
				durationLike.seconds = seconds;
				if (nanoseconds !== 0) durationLike.nanoseconds = nanoseconds;
			} else {
				durationLike[`${unit}s`] = value;
			}
		} else {
			throw new Error(`Internal error: Unknown unit ${unit}`);
		}

		const duration = Temporal.Duration.from(durationLike);
		return dt.add(duration);
	}

	// Group 2: Start/End of Unit
	switch (trimmedModifier) {
		case 'start of day':
			return dt.startOfDay();
		case 'start of month':
			return dt.startOfDay().with({ day: 1 });
		case 'start of year':
			return dt.startOfDay().with({ month: 1, day: 1 });
	}

	// Group 3: Weekday Adjustment
	const weekdayMatch = trimmedModifier.match(WEEKDAY_MODIFIER_REGEX);
	if (weekdayMatch) {
		const targetWeekday = parseInt(weekdayMatch[1], 10);
		const targetWeekdayISO = targetWeekday === 0 ? 7 : targetWeekday;
		const currentWeekdayISO = dt.dayOfWeek;
		let daysToAdd = targetWeekdayISO - currentWeekdayISO;
		if (daysToAdd > 0) {
			daysToAdd -= 7;
		}
		if (daysToAdd !== 0) {
			return dt.add({ days: daysToAdd });
		}
		return dt;
	}

	// Group 4: Timezone (Handled before modifier application)
	console.warn(`Modifier not implemented or unrecognized: ${modifier}`);
	return dt;
}


// --- Core Logic --- //

function processDateTimeArgs(args: ReadonlyArray<SqlValue>): Temporal.ZonedDateTime | null {
	if (args.length === 0) return null;

	let initialTimeVal = args[0];
	let startIndex = 1;
	let isUnixEpoch = false;
	let modifiers: SqlValue[] = [];

	const unixEpochIndex = args.findIndex(arg => typeof arg === 'string' && arg.trim().toLowerCase() === 'unixepoch');

	if (unixEpochIndex !== -1) {
		if (unixEpochIndex === 0) {
			if (args.length < 2) return null;
			initialTimeVal = args[1];
			isUnixEpoch = true;
			startIndex = 2;
			modifiers = args.slice(startIndex);
		} else {
			initialTimeVal = args[0];
			isUnixEpoch = true;
			if (typeof initialTimeVal !== 'number') return null;
			modifiers = args.slice(1).filter((_, i) => i !== (unixEpochIndex - 1));
			startIndex = 1;
		}
	} else {
		initialTimeVal = args[0];
		modifiers = args.slice(1);
		startIndex = 1;
	}

	// Determine target timezone from modifiers ('localtime' or 'utc')
	let targetTimeZoneId: string = 'UTC'; // Store ID as string, default to UTC
	const remainingModifiers: string[] = [];

	for (const mod of modifiers) {
		if (typeof mod !== 'string') continue;
		const lowerMod = mod.trim().toLowerCase();
		if (lowerMod === 'localtime') {
			targetTimeZoneId = Temporal.Now.timeZoneId();
		} else if (lowerMod === 'utc') {
			targetTimeZoneId = 'UTC'; // Use string literal
		} else {
			remainingModifiers.push(mod);
		}
	}

	// Parse the initial value
	let currentDt = parseToTemporal(initialTimeVal, isUnixEpoch);
	if (!currentDt) return null;

	// Adjust initial ZonedDateTime to the target timezone if necessary
	if (targetTimeZoneId !== currentDt.timeZoneId) {
		try {
			currentDt = currentDt.toInstant().toZonedDateTimeISO(targetTimeZoneId);
		} catch (e) {
			console.warn(`Failed to convert to timezone "${targetTimeZoneId}":`, e);
			return null;
		}
	}

	// Apply remaining modifiers
	for (const modifier of remainingModifiers) {
		if (typeof modifier !== 'string') continue;
		try {
			currentDt = applyTemporalModifier(currentDt, modifier);
		} catch (e) {
			console.warn(`Error applying modifier "${modifier}":`, e);
			return null;
		}
	}

	return currentDt;
}


// --- Function Implementations --- //

// date(timestring, modifier, ...)
const dateFuncImpl = (...args: SqlValue[]): SqlValue => {
	const finalDt = processDateTimeArgs(args);
	if (!finalDt) return null;
	return finalDt.toPlainDate().toString();
};
export const dateFunc = createScalarFunction(
	{ name: 'date', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	dateFuncImpl
);

// time(timestring, modifier, ...)
const timeFuncImpl = (...args: SqlValue[]): SqlValue => {
	const finalDt = processDateTimeArgs(args);
	if (!finalDt) return null;
	return finalDt.toPlainTime().toString({ smallestUnit: 'second' });
};
export const timeFunc = createScalarFunction(
	{ name: 'time', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	timeFuncImpl
);

// datetime(timestring, modifier, ...)
const datetimeFuncImpl = (...args: SqlValue[]): SqlValue => {
	const finalDt = processDateTimeArgs(args);
	if (!finalDt) return null;
	const datePart = finalDt.toPlainDate().toString();
	const timePart = finalDt.toPlainTime().toString({ smallestUnit: 'second' });
	return `${datePart} ${timePart}`;
};
export const datetimeFunc = createScalarFunction(
	{ name: 'datetime', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	datetimeFuncImpl
);

// julianday(timestring, modifier, ...)
const juliandayFuncImpl = (...args: SqlValue[]): SqlValue => {
	const finalDt = processDateTimeArgs(args);
	if (!finalDt) return null;
	const epochMillis = finalDt.toInstant().epochMilliseconds;
	return (epochMillis / MILLIS_PER_DAY) + JULIAN_DAY_UNIX_EPOCH;
};
export const juliandayFunc = createScalarFunction(
	{ name: 'julianday', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	juliandayFuncImpl
);

// strftime(format, timestring, modifier, ...)
const strftimeFuncImpl = (format: SqlValue, ...timeArgs: SqlValue[]): SqlValue => {
	if (typeof format !== 'string') return null;
	const finalDt = processDateTimeArgs(timeArgs);
	if (!finalDt) return null;

	try {
		let result = format;
		result = result.replace(/%./g, (match) => {
			switch (match) {
				// Date
				case '%Y': return finalDt.year.toString().padStart(4, '0');
				case '%m': return finalDt.month.toString().padStart(2, '0');
				case '%d': return finalDt.day.toString().padStart(2, '0');
				case '%j': return finalDt.dayOfYear.toString().padStart(3, '0');
				// Time
				case '%H': return finalDt.hour.toString().padStart(2, '0');
				case '%M': return finalDt.minute.toString().padStart(2, '0');
				case '%S': return finalDt.second.toString().padStart(2, '0');
				case '%f': // SQLite %f is .SSS
                    const msStr = finalDt.millisecond.toString().padStart(3,'0');
                    return `.${msStr}`;
                // Use epochMilliseconds and divide for %s
				case '%s': return Math.floor(finalDt.epochMilliseconds / 1000).toString();
				// Weekday / Week Number
				case '%w': return (finalDt.dayOfWeek % 7).toString(); // 0=Sunday..6=Saturday (SQLite)
                // Handle potentially undefined weekOfYear
				case '%W': return (finalDt.weekOfYear ?? 0).toString().padStart(2, '0');
				// Literal Percent
				case '%%': return '%';
				// TODO: Add more format specifiers as needed (%J, etc.)
				default:
					console.warn(`Unsupported strftime specifier: ${match}`);
					return match;
			}
		});
		return result;
	} catch (e) {
		console.error("Error during strftime formatting:", e);
		return null;
	}
};
export const strftimeFunc = createScalarFunction(
	{ name: 'strftime', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	strftimeFuncImpl
);
