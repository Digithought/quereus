/**
 * Represents the primitive types SQLite can handle internally in this JS implementation.
 * These are the values that can be stored in SQLite columns and passed as parameters.
 */
export type SqlValue = number | string | bigint | Uint8Array | boolean | null;

/**
 * Represents the result of an operation that might return a value or an error.
 * Used for operations where either success or failure needs to be explicitly handled.
 */
export interface SqlResult<T> {
	success: boolean;
	value?: T;
	error?: Error;
}

/**
 * Standard SQLite status/error codes that match the C implementation.
 * Used for error handling and determining operation results.
 */
export enum StatusCode {
	OK = 0,
	ERROR = 1,
	INTERNAL = 2,
	PERM = 3,
	ABORT = 4,
	BUSY = 5,
	LOCKED = 6,
	NOMEM = 7,
	READONLY = 8,
	INTERRUPT = 9,
	IOERR = 10,
	CORRUPT = 11,
	NOTFOUND = 12,
	FULL = 13,
	CANTOPEN = 14,
	PROTOCOL = 15,
	EMPTY = 16,
	SCHEMA = 17,
	TOOBIG = 18,
	CONSTRAINT = 19,
	MISMATCH = 20,
	MISUSE = 21,
	NOLFS = 22,
	AUTH = 23,
	FORMAT = 24,
	RANGE = 25,
	NOTADB = 26,
	NOTICE = 27,
	WARNING = 28,
	ROW = 100,
	DONE = 101,
}

/**
 * Fundamental SQLite datatypes/affinity types.
 * These determine how values are stored and compared within the database.
 */
export enum SqlDataType {
	INTEGER = 1,
	REAL = 2,
	TEXT = 3,
	BLOB = 4,
	NULL = 5,
	NUMERIC = 6,
}

// Add other core types/interfaces as needed, e.g., for Error objects.
