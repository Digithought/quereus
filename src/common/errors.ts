import { StatusCode } from './constants';
import type { Token } from '../parser/lexer';

/**
 * Base class for SQLiter specific errors
 */
export class SqliteError extends Error {
	public code: number;
	public cause?: Error;
	public line?: number;
	public column?: number;

	constructor(message: string, code: number = StatusCode.ERROR, cause?: Error, line?: number, column?: number) {
		super(message);
		this.code = code;
		this.name = 'SqliteError';
		this.cause = cause;
		this.line = line;
		this.column = column;

		// Enhance message with location if available
		if (line !== undefined && column !== undefined) {
			this.message = `${message} (at line ${line}, column ${column})`;
		}

		// Maintain stack trace in V8
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, SqliteError);
		}
	}
}

/**
 * Parser-specific error (includes token info)
 */
export class ParseError extends SqliteError {
	public token: Token;

	constructor(message: string, token: Token) {
		// Pass token location to SqliteError constructor
		super(message, StatusCode.ERROR, undefined, token.startLine, token.startColumn);
		this.token = token;
		this.name = 'ParseError';

		// Don't repeat location in the base message if it's already added
		// Let the base class handle adding location if needed.
		// this.message = `${message} (at line ${token.startLine}, column ${token.startColumn})`;
	}
}

/**
 * Error for constraint violations
 */
export class ConstraintError extends SqliteError {
	constructor(message: string, code: number = StatusCode.CONSTRAINT) {
		super(message, code);
		this.name = 'ConstraintError';
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
