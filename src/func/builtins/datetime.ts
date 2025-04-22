import { FunctionFlags } from '../../common/constants';
import { SqliteError } from '../../common/errors';
import type { SqlValue } from '../../common/types';
import { StatusCode } from '../../common/types';
import { createScalarFunction } from '../registration';
import type { SqliteContext } from '../context';

// --- Constants ---
const MILLIS_PER_DAY = 86400000;
const JULIAN_DAY_UNIX_EPOCH = 2440587.5;

// --- Parsing Helper --- //

/**
 * Parses various date/time string formats, Julian day numbers, or Unix timestamps
 * into milliseconds since the Unix epoch (UTC).
 * Mimics SQLite's date/time string parsing leniency.
 * @param timeVal The input value (string, number, null).
 * @returns Milliseconds since epoch (UTC) or null if parsing fails.
 */
function parseTimeToMillis(timeVal: SqlValue): number | null {
	if (timeVal === null || timeVal === undefined) return null;

	if (typeof timeVal === 'number') {
		// Check if it looks like a Julian day number (based on typical range)
		if (timeVal > 1000000 && timeVal < 4000000) { // Heuristic for JD
			return (timeVal - JULIAN_DAY_UNIX_EPOCH) * MILLIS_PER_DAY;
		} else {
			// Assume Unix timestamp (potentially fractional seconds)
			// Ensure it's within a reasonable range for seconds or milliseconds
			if (timeVal > -2208988800000 && timeVal < 32503680000000) { // Approx 1900 to 3000 AD in seconds
				return timeVal * 1000;
			} else if (timeVal > -2208988800000000 && timeVal < 32503680000000000) { // Approx 1900 to 3000 AD in milliseconds
				return timeVal;
			}
			return null; // Out of reasonable range
		}
	}

	if (typeof timeVal !== 'string') return null; // Only handle numbers and strings

	const lowerTimeVal = timeVal.trim().toLowerCase();
	if (lowerTimeVal === 'now') {
		return Date.now();
	}

	// Attempt ISO 8601 parsing (YYYY-MM-DD HH:MM:SS.SSS Z/+-HH:MM)
	try {
		// Date.parse is notoriously unreliable, especially for formats without T
		// and timezone handling. Manual parsing might be needed for full SQLite compat.
		// Basic attempt with common formats:
		let isoStr = timeVal.trim();
		// Replace space between date and time with 'T' if missing
		if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(isoStr)) {
			isoStr = isoStr.replace(' ', 'T');
		}
		// Add Z if no timezone specified, assuming UTC for parsing standard
		// This differs from JS Date default but matches SQLite's general handling?
		// Let's refine: If no Z or offset, Date.parse often assumes local. To mimic
		// SQLite needing explicit timezone info, we might need stricter parsing.
		// For now, let Date.parse handle it; may need adjustment.

		const ms = Date.parse(isoStr);
		if (!isNaN(ms)) {
			return ms;
		}
	} catch (e) { /* Ignore Date.parse errors, try fallback */ }

	// --- Fallback Parsing for Specific Formats ---

	// YYYY-MM-DD
	let match = timeVal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match) {
		const year = parseInt(match[1], 10);
		const month = parseInt(match[2], 10) - 1; // JS months are 0-indexed
		const day = parseInt(match[3], 10);
		if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
			const date = new Date(0); // Start at epoch
			date.setUTCFullYear(year, month, day);
			date.setUTCHours(0, 0, 0, 0); // Default time
			if (!isNaN(date.getTime())) return date.getTime();
		}
	}

	// YYYYMMDD
	match = timeVal.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (match) {
		const year = parseInt(match[1], 10);
		const month = parseInt(match[2], 10) - 1;
		const day = parseInt(match[3], 10);
		if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
			const date = new Date(0);
			date.setUTCFullYear(year, month, day);
			date.setUTCHours(0, 0, 0, 0);
			if (!isNaN(date.getTime())) return date.getTime();
		}
	}

	// HH:MM
	match = timeVal.match(/^(\d{2}):(\d{2})$/);
	if (match) {
		const hours = parseInt(match[1], 10);
		const minutes = parseInt(match[2], 10);
		if (!isNaN(hours) && hours >= 0 && hours < 24 && !isNaN(minutes) && minutes >= 0 && minutes < 60) {
			const date = new Date(0);
			date.setUTCFullYear(2000, 0, 1); // Default date
			date.setUTCHours(hours, minutes, 0, 0);
			if (!isNaN(date.getTime())) return date.getTime();
		}
	}

	// HH:MM:SS
	match = timeVal.match(/^(\d{2}):(\d{2}):(\d{2})$/);
	if (match) {
		const hours = parseInt(match[1], 10);
		const minutes = parseInt(match[2], 10);
		const seconds = parseInt(match[3], 10);
		if (!isNaN(hours) && hours >= 0 && hours < 24 && !isNaN(minutes) && minutes >= 0 && minutes < 60 && !isNaN(seconds) && seconds >= 0 && seconds < 60) {
			const date = new Date(0);
			date.setUTCFullYear(2000, 0, 1); // Default date
			date.setUTCHours(hours, minutes, seconds, 0);
			if (!isNaN(date.getTime())) return date.getTime();
		}
	}

	// HH:MM:SS.SSS
	match = timeVal.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
	if (match) {
		const hours = parseInt(match[1], 10);
		const minutes = parseInt(match[2], 10);
		const seconds = parseInt(match[3], 10);
		// Pad milliseconds string to 3 digits
		const msString = match[4].padEnd(3, '0');
		const milliseconds = parseInt(msString, 10);
		if (!isNaN(hours) && hours >= 0 && hours < 24 &&
			!isNaN(minutes) && minutes >= 0 && minutes < 60 &&
			!isNaN(seconds) && seconds >= 0 && seconds < 60 &&
			!isNaN(milliseconds) && milliseconds >= 0 && milliseconds < 1000)
		{
			const date = new Date(0);
			date.setUTCFullYear(2000, 0, 1); // Default date
			date.setUTCHours(hours, minutes, seconds, milliseconds);
			if (!isNaN(date.getTime())) return date.getTime();
		}
	}

	// TODO: Implement more robust manual parsing for SQLite specific formats
	// - DDDD (day number)

	console.warn(`Failed to parse date/time string: ${timeVal}`);
	return null;
}

// --- Core Date/Time Functions --- //

// Common logic for date/time functions (parsing + modifiers)
function dateTimeFuncLogic(args: ReadonlyArray<SqlValue>): Date | null {
	if (args.length === 0) return null;

	let initialTimeVal = args[0];
	let startIndex = 1;
	let isUnixEpoch = false;

	// Check for 'unixepoch' as the first argument
	if (typeof initialTimeVal === 'string' && initialTimeVal.trim().toLowerCase() === 'unixepoch') {
		if (args.length < 2) return null; // Need a value after 'unixepoch'
		isUnixEpoch = true;
		initialTimeVal = args[1];
		startIndex = 2;
	}

	let initialMillis: number | null;
	if (isUnixEpoch) {
		// Force interpretation as Unix seconds
		if (typeof initialTimeVal !== 'number') {
			return null; // Value after unixepoch must be numeric
		}
		initialMillis = initialTimeVal * 1000;
	} else {
		initialMillis = parseTimeToMillis(initialTimeVal);
	}

	if (initialMillis === null) return null;

	let currentMillis = initialMillis;
	let currentDate = new Date(currentMillis);
	let isLocalTime = false; // Flag to track if localtime modifier was used

	// Apply Modifiers
	for (let i = startIndex; i < args.length; i++) {
		const modifier = args[i];
		if (typeof modifier !== 'string') continue; // Modifiers must be strings

		// Handle timezone modifiers specially as they affect context/output
		const lowerModifier = modifier.trim().toLowerCase();
		if (lowerModifier === 'localtime') {
			isLocalTime = true;
			continue; // Don't pass to applyModifier, handled at formatting time
		}
		if (lowerModifier === 'utc') {
			isLocalTime = false;
			continue; // Don't pass to applyModifier, handled at formatting time
		}

		// Apply other modifiers
		try {
			currentDate = applyModifier(currentDate, modifier);
		} catch (e) {
			console.warn(`Error applying modifier "${modifier}":`, e);
			return null; // Fail if modifier application fails
		}
	}

	// Store timezone preference potentially on the Date object or return it?
	// Returning a tuple or object might be cleaner.
	// For now, let's return the Date and rely on formatting functions to check isLocalTime.
	// Add a non-standard property to Date to pass this info (might be fragile)
	(currentDate as any)._isLocalTime = isLocalTime;

	return currentDate;
}

// --- Modifier Application --- //

// Regex to parse relative time modifiers like '+1 day', '-3 months'
const RELATIVE_MODIFIER_REGEX = /^([+-]?\s*\d+(\.\d+)?)\s+(day|hour|minute|second|month|year)s?$/i;

function applyModifier(date: Date, modifier: string): Date {
	const trimmedModifier = modifier.trim().toLowerCase();

	// --- Group 1: Relative Time Shifts ---
	const relativeMatch = trimmedModifier.match(RELATIVE_MODIFIER_REGEX);
	if (relativeMatch) {
		const value = parseFloat(relativeMatch[1].replace(/\s/g, '')); // Remove spaces from number
		const unit = relativeMatch[3];

		if (isNaN(value)) {
			throw new Error(`Invalid number in modifier: ${modifier}`);
		}

		// Create a *new* Date object to avoid modifying the original in place
		const newDate = new Date(date.getTime());

		switch (unit) {
			case 'day':
				newDate.setUTCDate(newDate.getUTCDate() + value);
				break;
			case 'hour':
				newDate.setUTCHours(newDate.getUTCHours() + value);
				break;
			case 'minute':
				newDate.setUTCMinutes(newDate.getUTCMinutes() + value);
				break;
			case 'second':
				newDate.setUTCSeconds(newDate.getUTCSeconds() + value);
				// Handle fractional seconds by adding milliseconds
				if (!Number.isInteger(value)) {
					newDate.setUTCMilliseconds(newDate.getUTCMilliseconds() + (value % 1) * 1000);
				}
				break;
			case 'month':
				newDate.setUTCMonth(newDate.getUTCMonth() + Math.trunc(value));
				// TODO: Handle potential day overflow (e.g., Jan 31 + 1 month -> Feb 28/29)?
				// JS Date object handles this automatically.
				break;
			case 'year':
				newDate.setUTCFullYear(newDate.getUTCFullYear() + Math.trunc(value));
				break;
			default:
				// Should not happen due to regex match
				throw new Error(`Internal error: Unknown unit ${unit}`);
		}
		return newDate;
	}

	// --- Group 2: Start/End of Unit ---
	switch (trimmedModifier) {
		case 'start of day': {
			const newDate = new Date(date.getTime());
			newDate.setUTCHours(0, 0, 0, 0);
			return newDate;
		}
		case 'start of month': {
			const newDate = new Date(date.getTime());
			newDate.setUTCDate(1);
			newDate.setUTCHours(0, 0, 0, 0);
			return newDate;
		}
		case 'start of year': {
			const newDate = new Date(date.getTime());
			newDate.setUTCMonth(0, 1);
			newDate.setUTCHours(0, 0, 0, 0);
			return newDate;
		}
		// Handle 'weekday N'
		// Note: getUTCDay() returns 0 for Sunday, 1 for Monday, ..., 6 for Saturday
		case 'weekday 0': // Sunday
		case 'weekday 1': // Monday
		case 'weekday 2': // Tuesday
		case 'weekday 3': // Wednesday
		case 'weekday 4': // Thursday
		case 'weekday 5': // Friday
		case 'weekday 6': // Saturday
		{
			const newDate = new Date(date.getTime());
			const targetWeekday = parseInt(trimmedModifier.split(' ')[1], 10);
			const currentWeekday = newDate.getUTCDay();
			const diff = targetWeekday - currentWeekday;
			// If the current day is already past the target weekday, move to the *next* target weekday.
			// SQLite's behavior is to find the *next* occurrence (or current if same day).
			// However, some interpretations might go backward. Let's stick to forward/current.
			// This means if today is Wednesday(3) and target is Monday(1), go forward to next Monday.
			// Correction: SQLite goes backward unless the current day matches.
			let daysToAdd = diff;
			// SQLite: "weekday N" moves the date backward to the last day that was weekday N.
			// If the date is already weekday N, it remains unchanged.
			if (diff > 0) { // If target N is later in the week than current day...
				daysToAdd -= 7; // ...go back to the previous week's N.
			}
			// If diff <= 0, daysToAdd is already correct (negative or zero offset).
			newDate.setUTCDate(newDate.getUTCDate() + daysToAdd);
			return newDate;
		}
		// unixepoch is handled in dateTimeFuncLogic, not as a modifier
	}

	// --- Group 3: Timezone Conversion (TODO) ---
	switch (trimmedModifier) {
		case 'localtime':
			// TODO: This primarily affects formatting, not the internal Date value
			// Need to store a flag or adjust formatting logic later.
			break;
		case 'utc':
			// TODO: Ensure output is UTC (default behavior here)
			break;
	}

	console.warn(`Modifier not implemented or unrecognized: ${modifier}`);
	return date; // Return unmodified date for unimplemented/unrecognized modifiers
}

// date(timestring, modifier, ...)
const dateFuncImpl = (...args: SqlValue[]): SqlValue => {
	const finalDate = dateTimeFuncLogic(args);
	if (!finalDate) return null;
	const isLocal = (finalDate as any)._isLocalTime;
	// Format as YYYY-MM-DD
	const year = isLocal ? finalDate.getFullYear() : finalDate.getUTCFullYear();
	const month = (isLocal ? finalDate.getMonth() : finalDate.getUTCMonth()) + 1;
	const day = isLocal ? finalDate.getDate() : finalDate.getUTCDate();
	return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
};
export const dateFunc = createScalarFunction(
	{ name: 'date', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	dateFuncImpl
);

// time(timestring, modifier, ...)
const timeFuncImpl = (...args: SqlValue[]): SqlValue => {
	const finalDate = dateTimeFuncLogic(args);
	if (!finalDate) return null;
	const isLocal = (finalDate as any)._isLocalTime;
	// Format as HH:MM:SS
	const hours = isLocal ? finalDate.getHours() : finalDate.getUTCHours();
	const minutes = isLocal ? finalDate.getMinutes() : finalDate.getUTCMinutes();
	const seconds = isLocal ? finalDate.getSeconds() : finalDate.getUTCSeconds();
	return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};
export const timeFunc = createScalarFunction(
	{ name: 'time', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	timeFuncImpl
);

// datetime(timestring, modifier, ...)
const datetimeFuncImpl = (...args: SqlValue[]): SqlValue => {
	const finalDate = dateTimeFuncLogic(args);
	if (!finalDate) return null;
	// Format as YYYY-MM-DD HH:MM:SS
	// We need to call the logic again, but this time get the parts based on the flag
	// Re-calling dateTimeFuncLogic isn't ideal. Let's format directly.
	const isLocal = (finalDate as any)._isLocalTime;

	const year = isLocal ? finalDate.getFullYear() : finalDate.getUTCFullYear();
	const month = (isLocal ? finalDate.getMonth() : finalDate.getUTCMonth()) + 1;
	const day = isLocal ? finalDate.getDate() : finalDate.getUTCDate();
	const hours = isLocal ? finalDate.getHours() : finalDate.getUTCHours();
	const minutes = isLocal ? finalDate.getMinutes() : finalDate.getUTCMinutes();
	const seconds = isLocal ? finalDate.getSeconds() : finalDate.getUTCSeconds();

	const datePart = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
	const timePart = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

	return `${datePart} ${timePart}`;
};
export const datetimeFunc = createScalarFunction(
	{ name: 'datetime', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	datetimeFuncImpl
);

// julianday(timestring, modifier, ...)
const juliandayFuncImpl = (...args: SqlValue[]): SqlValue => {
	const finalDate = dateTimeFuncLogic(args);
	if (!finalDate) return null;
	// Calculate Julian Day
	const millis = finalDate.getTime();
	return (millis / MILLIS_PER_DAY) + JULIAN_DAY_UNIX_EPOCH;
};
export const juliandayFunc = createScalarFunction(
	{ name: 'julianday', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	juliandayFuncImpl
);

// strftime(format, timestring, modifier, ...)
const strftimeFuncImpl = (format: SqlValue, ...timeArgs: SqlValue[]): SqlValue => {
	if (typeof format !== 'string') return null;
	const finalDate = dateTimeFuncLogic(timeArgs);
	if (!finalDate) return null;
	const isLocal = (finalDate as any)._isLocalTime;

	// Helper function to calculate Day of Year
	const getDayOfYear = (d: Date): number => {
		const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
		const diff = d.getTime() - start.getTime();
		return Math.floor(diff / MILLIS_PER_DAY);
	};

	// Helper function to calculate Week of Year (Monday as first day)
	const getWeekOfYear = (d: Date): number => {
		const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
		// Adjust date to nearest Thursday: current date + 4 - current day number
		// Monday is 1, Sunday is 0 -> Adjust so Monday is 0 for calculation
		const dayNum = (d.getUTCDay() + 6) % 7;
		const dateCopy = new Date(d.getTime());
		dateCopy.setUTCDate(d.getUTCDate() - dayNum + 3);
		// Get the first Thursday of the year
		const firstThursday = new Date(Date.UTC(dateCopy.getUTCFullYear(), 0, 4));
		// Calculate the week number
		return 1 + Math.round(((dateCopy.getTime() - firstThursday.getTime()) / MILLIS_PER_DAY) / 7);
		// Alternative simpler (ISO 8601 Week): Might differ slightly from SQLite %W?
		// Needs verification against SQLite behavior
	};

	// TODO: Implement robust strftime formatting engine respecting isLocal
	console.warn(`strftime format requires review for full compatibility: ${format}`);
	// Simple placeholder using Date methods (needs isLocal awareness)
	try {
		let result = format;
		// Use replacer function to handle %% correctly
		result = result.replace(/%./g, (match) => {
			switch (match) {
				case '%Y': return (isLocal ? finalDate.getFullYear() : finalDate.getUTCFullYear()).toString();
				case '%m': return ((isLocal ? finalDate.getMonth() : finalDate.getUTCMonth()) + 1).toString().padStart(2, '0');
				case '%d': return (isLocal ? finalDate.getDate() : finalDate.getUTCDate()).toString().padStart(2, '0');
				case '%H': return (isLocal ? finalDate.getHours() : finalDate.getUTCHours()).toString().padStart(2, '0');
				case '%M': return (isLocal ? finalDate.getMinutes() : finalDate.getUTCMinutes()).toString().padStart(2, '0');
				case '%S': return (isLocal ? finalDate.getSeconds() : finalDate.getUTCSeconds()).toString().padStart(2, '0');
				// %s (unixepoch) should always be based on UTC time
				case '%s': return Math.floor(finalDate.getTime() / 1000).toString();
				// Added Specifiers
				case '%j': return getDayOfYear(finalDate).toString().padStart(3, '0');
				case '%w': return (isLocal ? finalDate.getDay() : finalDate.getUTCDay()).toString(); // 0=Sunday
				case '%W': return getWeekOfYear(finalDate).toString().padStart(2, '0');
				case '%%': return '%';
				// TODO: Add more format specifiers as needed (%j, %w, %W, %J, %%, etc.)
				default:
					console.warn(`Unsupported strftime specifier: ${match}`);
					return match; // Return the literal match if unsupported
			}
		});
		return result;
	} catch (e) {
		return null;
	}
};
export const strftimeFunc = createScalarFunction(
	{ name: 'strftime', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	strftimeFuncImpl
);
