import { StatusCode } from './constants';

/** Base class for SQLite-related errors */
export class SqliteError extends Error {
    public readonly code: StatusCode;

    constructor(message: string, code: StatusCode = StatusCode.ERROR) {
        super(message);
        this.name = 'SqliteError';
        this.code = code;
        // Ensure the prototype chain is correctly set up
        Object.setPrototypeOf(this, SqliteError.prototype);
    }
}

/** Specific error for constraint violations */
export class ConstraintError extends SqliteError {
    constructor(message: string = "Constraint violation") {
        super(message, StatusCode.CONSTRAINT);
        this.name = 'ConstraintError';
        Object.setPrototypeOf(this, ConstraintError.prototype);
    }
}

/** Specific error for syntax issues */
export class SyntaxError extends SqliteError {
    constructor(message: string = "SQL syntax error") {
        super(message, StatusCode.ERROR); // Often uses generic ERROR
        this.name = 'SyntaxError';
        Object.setPrototypeOf(this, SyntaxError.prototype);
    }
}

/** Specific error for API misuse */
export class MisuseError extends SqliteError {
    constructor(message: string = "API misuse") {
        super(message, StatusCode.MISUSE);
        this.name = 'MisuseError';
        Object.setPrototypeOf(this, MisuseError.prototype);
    }
}
