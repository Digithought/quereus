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
	astNode?: { loc?: { start: { line: number; column: number }, end?: { line: number; column: number } } }
): never {
	throw new QuereusError(
		message,
		code,
		cause,
		astNode?.loc?.start.line,
		astNode?.loc?.start.column
	);
}

/**
 * Information about an error in the error chain
 */
export interface ErrorInfo {
	message: string;
	code?: number;
	line?: number;
	column?: number;
	name: string;
	stack?: string;
}

/**
 * Recursively unwraps a QuereusError (or any Error) and its causes
 * @param error The error to unwrap
 * @returns Array of ErrorInfo objects, with the root error first
 */
export function unwrapError(error: Error): ErrorInfo[] {
	const errorChain: ErrorInfo[] = [];
	let currentError: Error | undefined = error;

	while (currentError) {
		const errorInfo: ErrorInfo = {
			message: currentError.message,
			name: currentError.name,
			stack: currentError.stack,
		};

		// Add QuereusError-specific fields if available
		if (currentError instanceof QuereusError) {
			errorInfo.code = currentError.code;
			errorInfo.line = currentError.line;
			errorInfo.column = currentError.column;
		}

		errorChain.push(errorInfo);

		// Move to the next error in the chain
		currentError = (currentError as any).cause;
	}

	return errorChain;
}

/**
 * Formats an error chain for display
 * @param errorChain Array of ErrorInfo objects
 * @param includeStack Whether to include stack traces
 * @returns Formatted error message
 */
export function formatErrorChain(errorChain: ErrorInfo[], includeStack: boolean = false): string {
	if (errorChain.length === 0) {
		return 'Unknown error';
	}

	const lines: string[] = [];

	errorChain.forEach((errorInfo, index) => {
		const prefix = index === 0 ? 'Error' : `Caused by`;
		let line = `${prefix}: ${errorInfo.message}`;

		if (errorInfo.line !== undefined && errorInfo.column !== undefined) {
			line += ` (at line ${errorInfo.line}, column ${errorInfo.column})`;
		}

		lines.push(line);

		if (includeStack && errorInfo.stack) {
			lines.push(errorInfo.stack);
		}
	});

	return lines.join('\n');
}

/**
 * Gets the primary error info (the first error in the chain)
 * @param error The error to analyze
 * @returns ErrorInfo for the primary error
 */
export function getPrimaryError(error: Error): ErrorInfo {
	const chain = unwrapError(error);
	return chain[0] || {
		message: 'Unknown error',
		name: 'Error',
	};
}
