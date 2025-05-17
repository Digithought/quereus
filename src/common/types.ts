export type DeepReadonly<T> = { readonly [P in keyof T]: DeepReadonly<T[P]> };

/**
 * Represents the primitive scalar types SQLite can handle internally in this implementation.
 * These are the values that can be stored in SQLite columns and passed as parameters.
 */
export type SqlValue = number | string | bigint | Uint8Array | boolean | null;

/**
 * Represents a row of data, which is an array of SqlValue.
 */
export type Row = SqlValue[];

/**
 * Represents a row with a rowid header.
 */
export type RowIdRow = [rowid: bigint, row: Row];

/**
 * Represents a value that can be expected as an input in the runtime environment.
 * This type can be a scalar value, or an async iterable of rows (cursor).
 */
export type RuntimeValue = SqlValue | AsyncIterable<Row>;

/**
 * Represents a value that can be output from the runtime, or an intermediate thereof.
 * This type can be a scalar value, a promise of a scalar value, an async iterable of rows (cursor), or an array of OutputValue (results).
 */
export type OutputValue = RuntimeValue | Promise<SqlValue> | RuntimeValue[];

/**
 * Represents the result of an operation that might return a value or an error.
 * Used for operations where either success or failure needs to be explicitly handled.
 */
export interface SqlResult<T> {
	success: boolean;
	value?: T;
	error?: Error;
}

export type SqlParameters = SqlValue[] | Record<string, SqlValue>

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
	UNSUPPORTED = 200,
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

export type CompareFn = (a: SqlValue, b: SqlValue) => number;
