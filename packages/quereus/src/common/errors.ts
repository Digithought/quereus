import { StatusCode } from './types.js';
import type { Token } from '../parser/lexer.js';

/**
 * Base class for Quereus specific errors
 * Provides location information and status code support
 */
export class QuereusError extends Error {
	public code: number;
	public cause?: Error;
	public line?: number;
	public column?: number;

	constructor(message: string, code: number = StatusCode.ERROR, cause?: Error, line?: number, column?: number) {
		super(message);
		this.code = code;
		this.name = 'QuereusError';
		this.cause = cause;
		this.line = line;
		this.column = column;

		// Enhance message with location if available
		if (line !== undefined && column !== undefined) {
			this.message = `${message} (at line ${line}, column ${column})`;
		}

		// Maintain stack trace in V8
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, QuereusError);
		}
	}
}

/**
 * Parser-specific error that includes token information
 * Used during SQL parsing to provide precise error locations
 */
export class ParseError extends QuereusError {
	public token: Token;

	constructor(message: string, token: Token) {
		super(message, StatusCode.ERROR, undefined, token.startLine, token.startColumn);
		this.token = token;
		this.name = 'ParseError';
	}
}

/**
 * Error thrown when a database constraint is violated
 */
export class ConstraintError extends QuereusError {
	constructor(message: string, code: number = StatusCode.CONSTRAINT) {
		super(message, code);
		this.name = 'ConstraintError';
	}
}

/**
 * Error thrown for SQL syntax issues
 */
export class SyntaxError extends QuereusError {
	constructor(message: string = "SQL syntax error") {
		super(message, StatusCode.ERROR);
		this.name = 'SyntaxError';
		Object.setPrototypeOf(this, SyntaxError.prototype);
	}
}

/**
 * Error thrown when the API is used incorrectly
 */
export class MisuseError extends QuereusError {
	constructor(message: string = "API misuse") {
		super(message, StatusCode.MISUSE);
		this.name = 'MisuseError';
		Object.setPrototypeOf(this, MisuseError.prototype);
	}
}

/**
 * Helper function to throw a QuereusError with optional location information from AST nodes
 * @param message Error message
 * @param code Status code (defaults to ERROR)
 * @param cause Optional underlying error
 * @param astNode Optional AST node or object with location information
 * @returns Never (always throws)
 */
export function quereusError(
	message: string,
	code: StatusCode = StatusCode.ERROR,
	cause?: Error,
	astNode?: { loc?: { start: { line: number; column: number } } }
): never {
	throw new QuereusError(
		message,
		code,
		cause,
		astNode?.loc?.start.line,
		astNode?.loc?.start.column
	);
}
