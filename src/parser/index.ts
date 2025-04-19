export * from './ast';
export * from './parser';
export * from './lexer';

import { Parser, ParseError } from './parser';
import type { SelectStmt, InsertStmt } from './ast';
import { TokenType } from './lexer';

/**
 * Parse a SQL SELECT statement
 * @param sql SQL statement
 * @returns AST for the SELECT statement
 */
export function parseSelect(sql: string): SelectStmt {
  const parser = new Parser();
  return parser.initialize(sql).selectStatement();
}

/**
 * Parse a SQL INSERT statement
 * @param sql SQL statement
 * @returns AST for the INSERT statement
 */
export function parseInsert(sql: string): InsertStmt {
  const parser = new Parser();
  return parser.initialize(sql).insertStatement();
}

/**
 * Parse any SQL statement (currently only supports SELECT and INSERT)
 * @param sql SQL statement
 * @returns AST for the statement
 */
export function parse(sql: string): SelectStmt | InsertStmt {
  const parser = new Parser();
  const stmt = parser.parse(sql);

  // Check statement type
  if (stmt.type === 'select') {
    return stmt as SelectStmt;
  } else if (stmt.type === 'insert') {
    return stmt as InsertStmt;
  }

  throw new Error(`Unsupported SQL statement type: ${stmt.type}`);
}
