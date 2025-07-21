import type { RuntimeContext } from '../runtime/types.js';

export type MaybePromise<T> = T | Promise<T>;

export type DeepReadonly<T> = { readonly [P in keyof T]: DeepReadonly<T[P]> };

/**
 * Represents the primitive scalar types Quereus can handle internally in this implementation.
 * These are the values that can be stored in Quereus columns and passed as parameters.
 */
export type SqlValue = string | number | bigint | boolean | Uint8Array | null;

/**
 * Represents a row of data, which is an array of SqlValue.
 */
export type Row = SqlValue[];

/**
 * Represents a value that can be expected as an input in the runtime environment.
 * This type can be a scalar value, or an async iterable of rows (cursor).
 */
export type RuntimeValue = SqlValue | Row | AsyncIterable<Row> | ((ctx: RuntimeContext) => OutputValue)

/** Represents a value that can be output from an instruction or program. */
export type OutputValue = MaybePromise<RuntimeValue>;

export type SqlParameters = Record<string, SqlValue> | SqlValue[];

/**
 * Standard status/error codes that significantly match SQLite.
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
	SYNTAX = 29,
	UNSUPPORTED = 30,
}

/**
 * Fundamental SQLite compatible datatypes/affinity types.
 * These determine how values are stored and compared within the database.
 */
export enum SqlDataType {
	NULL = 0,
	INTEGER = 1,
	REAL = 2,
	TEXT = 3,
	BLOB = 4,
	NUMERIC = 6, // For DECIMAL, NUMERIC with precision/scale
	BOOLEAN = 7, // For explicit BOOLEAN columns (future, not standard SQLite)
}

export type CompareFn = (a: SqlValue, b: SqlValue) => number;

export interface DatabaseInfo {
	path: string | ':memory:';
	isOpen: boolean;
	isReadonly: boolean;
	inTransaction: boolean;
	name: string;
}

/**
 * Shared configuration object that can be used by multiple databases
 */
export interface DatabaseConfig {
	/**
	 * Open the database in read-only mode
	 * @default false
	 */
	readonly?: boolean;

	/**
	 * Register default functions
	 * @default true
	 */
	registerDefaultFunctions?: boolean;

	/**
	 * Maximum number of retries when opening the database
	 * @default 3
	 */
	maxRetries?: number;

	/**
	 * Enable WAL mode (Write-Ahead Logging)
	 * @default true for file databases, false for in-memory
	 */
	enableWAL?: boolean;

	/**
	 * Synchronous setting ('OFF' | 'NORMAL' | 'FULL' | 'EXTRA')
	 * @default 'NORMAL' with WAL, 'FULL' without WAL
	 */
	synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';

	/**
	 * Journal mode ('DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL' | 'OFF')
	 * @default 'WAL' if enableWAL is true, 'DELETE' otherwise
	 */
	journalMode?: 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL' | 'OFF';

	/**
	 * Cache size in pages (negative value = KB)
	 * @default -2048 (2MB)
	 */
	cacheSize?: number;

	/**
	 * Page size in bytes (must be power of 2, 512-65536)
	 * @default 4096
	 */
	pageSize?: number;

	/**
	 * Foreign key constraint enforcement
	 * @default true
	 */
	foreignKeys?: boolean;
}
export type RowOp = 'insert' | 'update' | 'delete';

export type { JSONValue } from './json-types.js';
