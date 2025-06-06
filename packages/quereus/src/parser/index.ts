export * from './ast.js';
export * from './parser.js';
export * from './lexer.js';

import { Parser, ParseError } from './parser';
import type { SelectStmt, InsertStmt } from './ast';
import { TokenType } from './lexer';

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
		throw new Error(`Expected INSERT statement, but got ${stmt.type}`);
	}
	return stmt as InsertStmt;
}

/**
 * Parse a SQL statement
 *
 * @param sql SQL statement
 * @returns AST for the statement
 * @throws Error if the statement type is not supported
 */
export function parse(sql: string): SelectStmt | InsertStmt {
	const parser = new Parser();
	const stmt = parser.parse(sql);

	if (stmt.type === 'select') {
		return stmt as SelectStmt;
	} else if (stmt.type === 'insert') {
		return stmt as InsertStmt;
	}

	throw new Error(`Unsupported SQL statement type: ${stmt.type}`);
}
