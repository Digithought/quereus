import { PhysicalType, type LogicalType } from './logical-type.js';
import { Temporal } from 'temporal-polyfill';

/**
 * DATE type - stores ISO 8601 date strings (YYYY-MM-DD)
 * Uses Temporal.PlainDate for validation and parsing
 */
export const DATE_TYPE: LogicalType = {
	name: 'DATE',
	physicalType: PhysicalType.TEXT,
	isTemporal: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		try {
			Temporal.PlainDate.from(v);
			return true;
		} catch {
			return false;
		}
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'string') {
			try {
				const date = Temporal.PlainDate.from(v);
				return date.toString(); // ISO 8601 format: YYYY-MM-DD
			} catch (e) {
				throw new TypeError(`Cannot convert '${v}' to DATE: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (typeof v === 'number') {
			// Unix timestamp (milliseconds)
			const instant = Temporal.Instant.fromEpochMilliseconds(v);
			return instant.toZonedDateTimeISO('UTC').toPlainDate().toString();
		}
		throw new TypeError(`Cannot convert ${typeof v} to DATE`);
	},

	compare: (a, b) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;
		// ISO 8601 dates can be compared lexicographically
		return (a as string).localeCompare(b as string);
	},

	supportedCollations: [],
};

/**
 * TIME type - stores ISO 8601 time strings (HH:MM:SS or HH:MM:SS.sss)
 * Uses Temporal.PlainTime for validation and parsing
 */
export const TIME_TYPE: LogicalType = {
	name: 'TIME',
	physicalType: PhysicalType.TEXT,
	isTemporal: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		try {
			Temporal.PlainTime.from(v);
			return true;
		} catch {
			return false;
		}
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'string') {
			try {
				const time = Temporal.PlainTime.from(v);
				return time.toString(); // ISO 8601 format: HH:MM:SS or HH:MM:SS.sss
			} catch (e) {
				throw new TypeError(`Cannot convert '${v}' to TIME: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (typeof v === 'number') {
			// Seconds since midnight
			const hours = Math.floor(v / 3600) % 24;
			const minutes = Math.floor((v % 3600) / 60);
			const seconds = v % 60;
			const time = new Temporal.PlainTime(hours, minutes, seconds);
			return time.toString();
		}
		throw new TypeError(`Cannot convert ${typeof v} to TIME`);
	},

	compare: (a, b) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;
		// ISO 8601 times can be compared lexicographically
		return (a as string).localeCompare(b as string);
	},

	supportedCollations: [],
};

/**
 * DATETIME type - stores ISO 8601 datetime strings (YYYY-MM-DDTHH:MM:SS or with timezone)
 * Uses Temporal.PlainDateTime for validation and parsing
 */
export const DATETIME_TYPE: LogicalType = {
	name: 'DATETIME',
	physicalType: PhysicalType.TEXT,
	isTemporal: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		try {
			// Try PlainDateTime first
			Temporal.PlainDateTime.from(v);
			return true;
		} catch {
			try {
				// Also accept ZonedDateTime
				Temporal.ZonedDateTime.from(v);
				return true;
			} catch {
				return false;
			}
		}
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'string') {
			try {
				// Try PlainDateTime first
				const dt = Temporal.PlainDateTime.from(v);
				return dt.toString(); // ISO 8601 format: YYYY-MM-DDTHH:MM:SS
			} catch {
				try {
					// Try ZonedDateTime
					const zdt = Temporal.ZonedDateTime.from(v);
					return zdt.toString(); // ISO 8601 with timezone
				} catch (e) {
					throw new TypeError(`Cannot convert '${v}' to DATETIME: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}
		if (typeof v === 'number') {
			// Unix timestamp (milliseconds)
			const instant = Temporal.Instant.fromEpochMilliseconds(v);
			return instant.toZonedDateTimeISO('UTC').toString();
		}
		throw new TypeError(`Cannot convert ${typeof v} to DATETIME`);
	},

	compare: (a, b) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;
		// ISO 8601 datetimes can be compared lexicographically
		return (a as string).localeCompare(b as string);
	},

	supportedCollations: [],
};

/**
 * Parse human-readable duration strings into Temporal.Duration
 * Supports formats like "1 hour", "30 minutes", "2 days 3 hours"
 */
function parseHumanReadableDuration(input: string): Temporal.Duration | null {
	const normalized = input.trim().toLowerCase();

	// Handle negative durations
	const isNegative = normalized.startsWith('-');
	const workingInput = isNegative ? normalized.substring(1).trim() : normalized;

	// Pattern: [number] [unit]
	// Units: year(s), month(s), week(s), day(s), hour(s), minute(s), second(s), min(s), sec(s)
	const pattern = /(\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?|hours?|minutes?|seconds?|mins?|secs?)/g;

	const components: Record<string, number> = {};
	let match;
	let hasMatch = false;

	while ((match = pattern.exec(workingInput)) !== null) {
		hasMatch = true;
		const value = parseFloat(match[1]);
		const unit = match[2];

		// Map unit to Temporal.Duration field
		if (unit.startsWith('year')) {
			components.years = (components.years || 0) + value;
		} else if (unit.startsWith('month')) {
			components.months = (components.months || 0) + value;
		} else if (unit.startsWith('week')) {
			components.weeks = (components.weeks || 0) + value;
		} else if (unit.startsWith('day')) {
			components.days = (components.days || 0) + value;
		} else if (unit.startsWith('hour')) {
			components.hours = (components.hours || 0) + value;
		} else if (unit.startsWith('min')) {
			components.minutes = (components.minutes || 0) + value;
		} else if (unit.startsWith('sec')) {
			components.seconds = (components.seconds || 0) + value;
		}
	}

	if (!hasMatch) return null;

	try {
		const duration = Temporal.Duration.from(components);
		return isNegative ? duration.negated() : duration;
	} catch {
		return null;
	}
}

/**
 * TIMESPAN type - stores ISO 8601 duration strings
 * Uses Temporal.Duration for validation and parsing
 */
export const TIMESPAN_TYPE: LogicalType = {
	name: 'TIMESPAN',
	physicalType: PhysicalType.TEXT,
	isTemporal: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		try {
			Temporal.Duration.from(v);
			return true;
		} catch {
			// Try parsing human-readable format
			return parseHumanReadableDuration(v) !== null;
		}
	},

	parse: (v) => {
		if (v === null) return null;

		if (typeof v === 'number') {
			// Interpret as seconds
			const duration = Temporal.Duration.from({ seconds: v });
			return duration.toString();
		}

		if (typeof v === 'string') {
			try {
				// Try ISO 8601 first
				const duration = Temporal.Duration.from(v);
				return duration.toString();
			} catch {
				// Try human-readable format
				const duration = parseHumanReadableDuration(v);
				if (duration) return duration.toString();
				throw new TypeError(`Cannot convert '${v}' to TIMESPAN`);
			}
		}

		throw new TypeError(`Cannot convert ${typeof v} to TIMESPAN`);
	},

	compare: (a, b) => {
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

		try {
			const durationA = Temporal.Duration.from(a as string);
			const durationB = Temporal.Duration.from(b as string);

			// Use a reference date to resolve calendar units
			// This ensures consistent comparison of durations with months/years
			const referenceDate = Temporal.PlainDate.from('2024-01-01');
			const totalA = durationA.total({ unit: 'seconds', relativeTo: referenceDate });
			const totalB = durationB.total({ unit: 'seconds', relativeTo: referenceDate });

			return totalA < totalB ? -1 : totalA > totalB ? 1 : 0;
		} catch {
			// If parsing fails, fall back to string comparison
			return (a as string).localeCompare(b as string);
		}
	},

	supportedCollations: [],
};

