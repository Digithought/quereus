import { quereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
export * from './ast.js';
export * from './parser.js';
export * from './lexer.js';

import { Parser } from './parser.js';
import type { Statement, SelectStmt, InsertStmt } from './ast.js';

/**
 * Parse a single SQL statement into an AST node.
 *
 * @param sql SQL statement
 * @returns AST for the statement
 * @throws ParseError if the SQL is invalid
 */
export function parse(sql: string): Statement {
	const parser = new Parser();
	return parser.parse(sql);
}

/**
 * Parse multiple SQL statements separated by semicolons.
 *
 * @param sql SQL text containing one or more statements
 * @returns Array of AST nodes for each statement
 * @throws ParseError if the SQL is invalid
 */
export function parseAll(sql: string): Statement[] {
	const parser = new Parser();
	return parser.parseAll(sql);
}

/**
 * Parse a SQL SELECT statement
 *
 * @param sql SQL SELECT statement
 * @returns AST for the SELECT statement
 * @throws ParseError if the SQL is invalid or not a SELECT statement
 */
export function parseSelect(sql: string): SelectStmt {
	const parser = new Parser();
	return parser.initialize(sql).selectStatement();
}

/**
 * Parse a SQL INSERT statement
 *
 * @param sql SQL INSERT statement
 * @returns AST for the INSERT statement
 * @throws Error if the SQL is not an INSERT statement
 */
export function parseInsert(sql: string): InsertStmt {
	const stmt = parse(sql);
	if (stmt.type !== 'insert') {
		quereusError(
			`Expected INSERT statement, but got ${stmt.type}`,
			StatusCode.ERROR,
			undefined,
			stmt
		);
	}
	return stmt as InsertStmt;
}
