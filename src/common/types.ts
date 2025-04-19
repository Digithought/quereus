/** Represents the primitive types SQLite can handle internally in this JS port. */
export type SqlValue = number | string | bigint | Uint8Array | boolean | null;

/** Represents the result of an operation that might return a value or an error. */
export interface SqlResult<T> {
    success: boolean;
    value?: T;
    error?: Error; // Or a custom error type/enum
}

/** Represents common SQLite status codes. */
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
    // Add other relevant codes as needed
}

/** Represents the fundamental SQLite datatypes for type checking/coercion if needed. */
export enum SqlDataType {
    INTEGER = 1,
    FLOAT = 2,
    TEXT = 3,
    BLOB = 4,
    NULL = 5,
}

// Add other core types/interfaces as needed, e.g., for Error objects.
