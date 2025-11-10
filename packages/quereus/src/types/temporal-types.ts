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

