/**
 * SQL Parser for SQLiter
 *
 * Implements a recursive descent parser for SQL statements
 * with initial focus on SELECT statements
 */

import { Lexer, type Token, TokenType } from './lexer';
import * as AST from './ast';
import { ConflictResolution } from '../common/constants'; // Needed for constraints

/**
 * SQL Parser error
 */
export class ParseError extends Error {
	token: Token;

	constructor(token: Token, message: string) {
		super(message);
		this.token = token;
		this.name = 'ParseError';
	}
}

/**
 * SQL Parser class
 */
export class Parser {
	private tokens: Token[] = [];
	private current = 0;
	// Counter for positional parameters
	private parameterPosition = 1;

	/**
	 * Initialize the parser with tokens from a SQL string
	 * @param sql SQL string to parse
	 * @returns this parser instance for chaining
	 */
	initialize(sql: string): Parser {
		const lexer = new Lexer(sql);
		this.tokens = lexer.scanTokens();
		this.current = 0;
		this.parameterPosition = 1; // Reset parameter counter

		// Check for errors from lexer
		const errorToken = this.tokens.find(t => t.type === TokenType.ERROR);
		if (errorToken) {
			throw new ParseError(errorToken, errorToken.lexeme);
		}

		return this;
	}

	/**
	 * Parse SQL text into an AST
	 */
	parse(sql: string): AST.AstNode {
		this.initialize(sql);

		// Parse statement
		try {
			// --- Parse optional WITH clause first ---
			const withClause = this.tryParseWithClause();
			// --- Then parse the main statement ---
			const mainStatement = this.statement();
			// --- Attach WITH clause if present ---
			if (withClause && 'withClause' in mainStatement) {
				(mainStatement as any).withClause = withClause;
			} else if (withClause) {
				// Throw error if WITH is used with unsupported statement type
				throw this.error(this.previous(), `WITH clause cannot be used with ${mainStatement.type} statement.`);
			}
			return mainStatement;
		} catch (e) {
			if (e instanceof ParseError) {
				throw e;
			}
			// Unknown error
			console.error("Unhandled parser error:", e); // Log unexpected errors
			throw new Error(`Parser error: ${e instanceof Error ? e.message : e}`);
		}
	}

	/**
	 * Attempts to parse a WITH clause if present.
	 * @returns The WithClause AST node or undefined if no WITH clause is found.
	 */
	private tryParseWithClause(): AST.WithClause | undefined {
		if (!this.check(TokenType.IDENTIFIER) || this.peek().lexeme.toUpperCase() !== 'WITH') {
			return undefined;
		}
		this.advance(); // Consume WITH

		const recursive = this.matchKeyword('RECURSIVE');

		const ctes: AST.CommonTableExpr[] = [];
		do {
			ctes.push(this.commonTableExpression());
		} while (this.match(TokenType.COMMA));

		return { type: 'withClause', recursive, ctes };
	}

	/**
	 * Parses a single Common Table Expression (CTE).
	 * cte_name [(col1, col2, ...)] AS (query)
	 */
	private commonTableExpression(): AST.CommonTableExpr {
		const name = this.consumeIdentifier("Expected CTE name.");

		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					columns.push(this.consumeIdentifier("Expected column name in CTE definition."));
				} while (this.match(TokenType.COMMA));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after CTE column list.");
		}

		this.consume(TokenType.AS, "Expected 'AS' after CTE name.");
		this.consume(TokenType.LPAREN, "Expected '(' before CTE query.");

		// Parse the CTE query (can be SELECT, VALUES (via SELECT), INSERT, UPDATE, DELETE)
		let query: AST.SelectStmt | AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt;
		if (this.check(TokenType.SELECT)) {
			query = this.selectStatement();
		} else if (this.check(TokenType.INSERT)) {
			query = this.insertStatement();
		} else if (this.check(TokenType.UPDATE)) {
			query = this.updateStatement();
		} else if (this.check(TokenType.DELETE)) {
			query = this.deleteStatement();
		}
		// TODO: Add support for VALUES directly if needed (though VALUES is usually part of SELECT)
		else {
			throw this.error(this.peek(), "Expected SELECT, INSERT, UPDATE, or DELETE statement for CTE query.");
		}

		this.consume(TokenType.RPAREN, "Expected ')' after CTE query.");

		return { type: 'commonTableExpr', name, columns, query };
	}

	/**
	 * Parse a single SQL statement
	 */
	private statement(): AST.AstNode {
		// --- Check for specific keywords first ---
		const currentKeyword = this.peek().lexeme.toUpperCase();
		switch (currentKeyword) {
			case 'SELECT': this.advance(); return this.selectStatement();
			case 'INSERT': this.advance(); return this.insertStatement();
			case 'UPDATE': this.advance(); return this.updateStatement();
			case 'DELETE': this.advance(); return this.deleteStatement();
			case 'CREATE': this.advance(); return this.createStatement();
			case 'DROP': this.advance(); return this.dropStatement();
			case 'ALTER': this.advance(); return this.alterTableStatement();
			case 'BEGIN': this.advance(); return this.beginStatement();
			case 'COMMIT': this.advance(); return this.commitStatement();
			case 'ROLLBACK': this.advance(); return this.rollbackStatement();
			case 'SAVEPOINT': this.advance(); return this.savepointStatement();
			case 'RELEASE': this.advance(); return this.releaseStatement();
			case 'PRAGMA': this.advance(); return this.pragmaStatement();
			// --- Add default case ---
			default:
				// If it wasn't a recognized keyword starting the statement
				throw this.error(this.peek(), 'Expected statement type (SELECT, INSERT, UPDATE, DELETE, CREATE, etc.).');
		}
	}

	/**
	 * Parse an INSERT statement
	 * @returns AST for the INSERT statement
	 */
	insertStatement(): AST.InsertStmt {
		// INTO keyword is optional in SQLite
		this.matchKeyword('INTO'); // Handle missing keyword gracefully

		// Parse the table reference
		const table = this.tableIdentifier();

		// Parse column list if provided
		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = [];
			do {
				if (!this.check(TokenType.IDENTIFIER)) {
					throw this.error(this.peek(), "Expected column name.");
				}
				columns.push(this.advance().lexeme);
			} while (this.match(TokenType.COMMA));

			this.consume(TokenType.RPAREN, "Expected ')' after column list.");
		}

		// Parse VALUES clause
		let values: AST.Expression[][] | undefined;
		let select: AST.SelectStmt | undefined;

		if (this.match(TokenType.VALUES)) {
			values = [];
			do {
				this.consume(TokenType.LPAREN, "Expected '(' before values.");
				const valueList: AST.Expression[] = [];

				if (!this.check(TokenType.RPAREN)) { // Check for empty value list
					do {
						valueList.push(this.expression());
					} while (this.match(TokenType.COMMA));
				}

				this.consume(TokenType.RPAREN, "Expected ')' after values.");
				values.push(valueList);
			} while (this.match(TokenType.COMMA));
		} else if (this.check(TokenType.SELECT)) {
			// Handle INSERT ... SELECT
			select = this.selectStatement();
		} else {
			throw this.error(this.peek(), "Expected VALUES or SELECT after INSERT.");
		}

		return {
			type: 'insert',
			table,
			columns,
			values,
			select
		};
	}

	/**
	 * Parse a SELECT statement
	 * @returns AST for the SELECT statement
	 */
	selectStatement(): AST.SelectStmt {
		const distinct = this.matchKeyword('DISTINCT');
		const all = !distinct && this.matchKeyword('ALL');

		// Parse column list
		const columns = this.columnList();

		// Parse FROM clause if present
		let from: AST.FromClause[] | undefined;
		if (this.match(TokenType.FROM)) {
			from = this.tableSourceList();
		}

		// Parse WHERE clause if present
		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}

		// Parse GROUP BY clause if present
		let groupBy: AST.Expression[] | undefined;
		if (this.match(TokenType.GROUP) && this.consume(TokenType.BY, "Expected 'BY' after 'GROUP'.")) {
			groupBy = [];
			do {
				groupBy.push(this.expression());
			} while (this.match(TokenType.COMMA));
		}

		// Parse HAVING clause if present
		let having: AST.Expression | undefined;
		if (this.match(TokenType.HAVING)) {
			having = this.expression();
		}

		// Parse ORDER BY clause if present
		let orderBy: AST.OrderByClause[] | undefined;
		if (this.match(TokenType.ORDER) && this.consume(TokenType.BY, "Expected 'BY' after 'ORDER'.")) {
			orderBy = [];
			do {
				const expr = this.expression();
				const direction = this.match(TokenType.DESC) ? 'desc' :
					(this.match(TokenType.ASC) ? 'asc' : 'asc'); // Default to ASC
				orderBy.push({ expr, direction });
			} while (this.match(TokenType.COMMA));
		}

		// Parse LIMIT clause if present
		let limit: AST.Expression | undefined;
		let offset: AST.Expression | undefined;
		if (this.match(TokenType.LIMIT)) {
			limit = this.expression();

			// LIMIT x OFFSET y syntax
			if (this.match(TokenType.OFFSET)) {
				offset = this.expression();
			}
			// LIMIT x, y syntax (x is offset, y is limit)
			else if (this.match(TokenType.COMMA)) {
				offset = limit;
				limit = this.expression();
			}
		}

		// Check for UNION clause
		let union: AST.SelectStmt | undefined;
		let unionAll = false;
		if (this.match(TokenType.UNION)) {
			unionAll = this.match(TokenType.ALL);
			if (this.match(TokenType.SELECT)) {
				union = this.selectStatement();
			} else {
				throw this.error(this.peek(), "Expected 'SELECT' after 'UNION'.");
			}
		}

		return {
			type: 'select',
			columns,
			from,
			where,
			groupBy,
			having,
			orderBy,
			limit,
			offset,
			distinct,
			all,
			union,
			unionAll
		};
	}

	/**
	 * Parse a comma-separated list of result columns for SELECT
	 */
	private columnList(): AST.ResultColumn[] {
		const columns: AST.ResultColumn[] = [];

		do {
			// Handle wildcard: * or table.*
			if (this.match(TokenType.ASTERISK)) {
				columns.push({ type: 'all' });
			}
			// Handle table.* syntax
			else if (this.check(TokenType.IDENTIFIER) && this.checkNext(1, TokenType.DOT) &&
				this.checkNext(2, TokenType.ASTERISK)) {
				const table = this.advance().lexeme;
				this.advance(); // consume DOT
				this.advance(); // consume ASTERISK
				columns.push({ type: 'all', table });
			}
			// Handle regular column expression
			else {
				const expr = this.expression();
				let alias: string | undefined;

				// Handle AS alias or just alias
				if (this.match(TokenType.AS)) {
					if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.STRING)) {
						alias = this.advance().lexeme;
						if (this.previous().type === TokenType.STRING) {
							alias = this.previous().literal;
						}
					} else {
						throw this.error(this.peek(), "Expected identifier after 'AS'.");
					}
				}
				// Implicit alias (no AS keyword)
				else if (this.check(TokenType.IDENTIFIER) &&
					!this.checkNext(1, TokenType.LPAREN) &&
					!this.checkNext(1, TokenType.DOT) &&
					!this.checkNext(1, TokenType.COMMA) &&
					!this.isEndOfClause()) {
					alias = this.advance().lexeme;
				}

				columns.push({ type: 'column', expr, alias });
			}
		} while (this.match(TokenType.COMMA));

		return columns;
	}

	/**
	 * Parse a table identifier (possibly schema-qualified)
	 */
	private tableIdentifier(): AST.IdentifierExpr {
		let schema: string | undefined;
		let name: string;

		if (this.check(TokenType.IDENTIFIER) && this.checkNext(1, TokenType.DOT)) {
			schema = this.advance().lexeme;
			this.advance(); // Consume DOT
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected table name after schema.");
			}
			name = this.advance().lexeme;
		} else if (this.check(TokenType.IDENTIFIER)) {
			name = this.advance().lexeme;
		} else {
			throw this.error(this.peek(), "Expected table name.");
		}

		return {
			type: 'identifier',
			name,
			schema
		};
	}

	/**
	 * Parse a comma-separated list of table sources (FROM clause)
	 */
	private tableSourceList(): AST.FromClause[] {
		const sources: AST.FromClause[] = [];

		do {
			// Get the base table source
			let source: AST.FromClause = this.tableSource();

			// Look for JOINs
			while (this.isJoinToken()) {
				source = this.joinClause(source);
			}

			sources.push(source);
		} while (this.match(TokenType.COMMA));

		return sources;
	}

	/**
	 * Parse a single table source, which can now be a table name or a table-valued function call
	 */
	private tableSource(): AST.TableSource | AST.FunctionSource {
		// Check for function call syntax: IDENTIFIER (
		if (this.check(TokenType.IDENTIFIER) && this.checkNext(1, TokenType.LPAREN)) {
			return this.functionSource();
		}
		// Otherwise, assume it's a standard table source
		else {
			return this.standardTableSource();
		}
	}

	/** Parses a standard table source (schema.table or table) */
	private standardTableSource(): AST.TableSource {
		// Parse table name (potentially schema-qualified)
		const table = this.tableIdentifier();

		// Parse optional alias
		let alias: string | undefined;
		if (this.match(TokenType.AS)) {
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected alias after 'AS'.");
			}
			alias = this.advance().lexeme;
		} else if (this.check(TokenType.IDENTIFIER) &&
			!this.checkNext(1, TokenType.DOT) &&
			!this.checkNext(1, TokenType.COMMA) &&
			!this.isJoinToken() &&
			!this.isEndOfClause()) {
			alias = this.advance().lexeme;
		}

		return {
			type: 'table',
			table,
			alias
		};
	}

	/** Parses a table-valued function source: name(arg1, ...) [AS alias] */
	private functionSource(): AST.FunctionSource {
		const name = this.tableIdentifier(); // Use tableIdentifier to allow schema.func if needed

		this.consume(TokenType.LPAREN, "Expected '(' after table function name.");

		const args: AST.Expression[] = [];
		if (!this.check(TokenType.RPAREN)) {
			do {
				args.push(this.expression());
			} while (this.match(TokenType.COMMA));
		}

		this.consume(TokenType.RPAREN, "Expected ')' after table function arguments.");

		// Parse optional alias (same logic as for standard tables)
		let alias: string | undefined;
		if (this.match(TokenType.AS)) {
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected alias after 'AS'.");
			}
			alias = this.advance().lexeme;
		} else if (this.check(TokenType.IDENTIFIER) &&
			!this.checkNext(1, TokenType.DOT) &&
			!this.checkNext(1, TokenType.COMMA) &&
			!this.isJoinToken() &&
			!this.isEndOfClause()) {
			alias = this.advance().lexeme;
		}

		return {
			type: 'functionSource',
			name,
			args,
			alias
		};
	}

	/**
	 * Parse a JOIN clause
	 */
	private joinClause(left: AST.FromClause): AST.JoinClause {
		// Determine join type
		let joinType: 'inner' | 'left' | 'right' | 'full' | 'cross' = 'inner';

		if (this.match(TokenType.LEFT)) {
			this.match(TokenType.OUTER); // optional
			joinType = 'left';
		} else if (this.match(TokenType.RIGHT)) {
			this.match(TokenType.OUTER); // optional
			joinType = 'right';
		} else if (this.match(TokenType.FULL)) {
			this.match(TokenType.OUTER); // optional
			joinType = 'full';
		} else if (this.match(TokenType.CROSS)) {
			joinType = 'cross';
		} else if (this.match(TokenType.INNER)) {
			joinType = 'inner';
		}

		// Consume JOIN token
		this.consume(TokenType.JOIN, "Expected 'JOIN'.");

		// Parse right side of join
		const right = this.tableSource();

		// Parse join condition
		let condition: AST.Expression | undefined;
		let columns: string[] | undefined;

		if (this.match(TokenType.ON)) {
			condition = this.expression();
		} else if (this.match(TokenType.USING)) {
			this.consume(TokenType.LPAREN, "Expected '(' after 'USING'.");
			columns = [];

			do {
				if (!this.check(TokenType.IDENTIFIER)) {
					throw this.error(this.peek(), "Expected column name.");
				}
				columns.push(this.advance().lexeme);
			} while (this.match(TokenType.COMMA));

			this.consume(TokenType.RPAREN, "Expected ')' after columns.");
		} else if (joinType !== 'cross') {
			throw this.error(this.peek(), "Expected 'ON' or 'USING' after JOIN.");
		}

		return {
			type: 'join',
			joinType,
			left,
			right,
			condition,
			columns
		};
	}

	/**
	 * Parse an expression
	 */
	private expression(): AST.Expression {
		return this.logicalOr();
	}

	/**
	 * Parse logical OR expression
	 */
	private logicalOr(): AST.Expression {
		let expr = this.logicalAnd();

		while (this.match(TokenType.OR)) {
			const operator = 'OR';
			const right = this.logicalAnd();
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right
			};
		}

		return expr;
	}

	/**
	 * Parse logical AND expression
	 */
	private logicalAnd(): AST.Expression {
		let expr = this.equality();

		while (this.match(TokenType.AND)) {
			const operator = 'AND';
			const right = this.equality();
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right
			};
		}

		return expr;
	}

	/**
	 * Parse equality expression
	 */
	private equality(): AST.Expression {
		let expr = this.comparison();

		while (this.match(TokenType.EQUAL, TokenType.EQUAL_EQUAL, TokenType.NOT_EQUAL)) {
			const operator = this.previous().type === TokenType.NOT_EQUAL ? '!=' : '=';
			const right = this.comparison();
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right
			};
		}

		return expr;
	}

	/**
	 * Parse comparison expression
	 */
	private comparison(): AST.Expression {
		let expr = this.term();

		while (this.match(
			TokenType.LESS, TokenType.LESS_EQUAL,
			TokenType.GREATER, TokenType.GREATER_EQUAL
		)) {
			let operator: string;
			switch (this.previous().type) {
				case TokenType.LESS: operator = '<'; break;
				case TokenType.LESS_EQUAL: operator = '<='; break;
				case TokenType.GREATER: operator = '>'; break;
				case TokenType.GREATER_EQUAL: operator = '>='; break;
				default: operator = '?';
			}

			const right = this.term();
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right
			};
		}

		return expr;
	}

	/**
	 * Parse addition and subtraction
	 */
	private term(): AST.Expression {
		let expr = this.factor();

		while (this.match(TokenType.PLUS, TokenType.MINUS)) {
			const operator = this.previous().type === TokenType.PLUS ? '+' : '-';
			const right = this.factor();
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right
			};
		}

		return expr;
	}

	/**
	 * Parse multiplication and division
	 */
	private factor(): AST.Expression {
		let expr = this.primary();

		while (this.match(TokenType.ASTERISK, TokenType.SLASH, TokenType.PERCENT)) {
			let operator: string;
			switch (this.previous().type) {
				case TokenType.ASTERISK: operator = '*'; break;
				case TokenType.SLASH: operator = '/'; break;
				case TokenType.PERCENT: operator = '%'; break;
				default: operator = '?';
			}

			const right = this.primary();
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right
			};
		}

		return expr;
	}

	/**
	 * Parse primary expressions (literals, identifiers, etc.)
	 */
	private primary(): AST.Expression {
		// Literals
		if (this.match(TokenType.INTEGER, TokenType.FLOAT, TokenType.STRING, TokenType.NULL, TokenType.BLOB)) {
			const token = this.previous();
			let value: any = token.literal;

			if (token.type === TokenType.NULL) {
				value = null;
			}

			return {
				type: 'literal',
				value
			};
		}

		// Parameter expressions (?, :name, $name)
		if (this.match(TokenType.QUESTION)) {
			// Positional parameter
			return {
				type: 'parameter',
				index: this.parameterPosition++
			};
		}

		if (this.match(TokenType.COLON, TokenType.DOLLAR)) {
			// Named parameter
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected identifier after parameter prefix.");
			}
			const name = this.advance().lexeme;
			return {
				type: 'parameter',
				name
			};
		}

		// Function call
		if (this.check(TokenType.IDENTIFIER) && this.checkNext(1, TokenType.LPAREN)) {
			const name = this.advance().lexeme;

			this.consume(TokenType.LPAREN, "Expected '(' after function name.");

			const args: AST.Expression[] = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					if (this.match(TokenType.ASTERISK)) {
						args.push({ type: 'literal', value: '*' } as any);
					} else {
						args.push(this.expression());
					}
				} while (this.match(TokenType.COMMA));
			}

			this.consume(TokenType.RPAREN, "Expected ')' after function arguments.");

			// TODO: check for aggregate functions
			return {
				type: 'function',
				name,
				args
			};
		}

		// Column/identifier expressions
		if (this.check(TokenType.IDENTIFIER)) {
			// Schema.table.column
			if (this.checkNext(1, TokenType.DOT) && this.checkNext(2, TokenType.IDENTIFIER) &&
				this.checkNext(3, TokenType.DOT) && this.checkNext(4, TokenType.IDENTIFIER)) {
				const schema = this.advance().lexeme;
				this.advance(); // Consume DOT
				const table = this.advance().lexeme;
				this.advance(); // Consume DOT
				const name = this.advance().lexeme;

				return {
					type: 'column',
					name,
					table,
					schema
				};
			}
			// table.column
			else if (this.checkNext(1, TokenType.DOT) && this.checkNext(2, TokenType.IDENTIFIER)) {
				const table = this.advance().lexeme;
				this.advance(); // Consume DOT
				const name = this.advance().lexeme;

				return {
					type: 'column',
					name,
					table
				};
			}
			// just column
			else {
				const name = this.advance().lexeme;

				return {
					type: 'column',
					name
				};
			}
		}

		// Parenthesized expression
		if (this.match(TokenType.LPAREN)) {
			const expr = this.expression();
			this.consume(TokenType.RPAREN, "Expected ')' after expression.");
			return expr;
		}

		throw this.error(this.peek(), "Expected expression.");
	}

	// Helper methods for token management

	private match(...types: TokenType[]): boolean {
		for (const type of types) {
			if (this.check(type)) {
				this.advance();
				return true;
			}
		}
		return false;
	}

	private consume(type: TokenType, message: string): boolean {
		if (this.check(type)) {
			this.advance();
			return true;
		}

		throw this.error(this.peek(), message);
	}

	private check(type: TokenType): boolean {
		if (this.isAtEnd()) return false;
		return this.peek().type === type;
	}

	private checkNext(n: number, type: TokenType): boolean {
		if (this.current + n >= this.tokens.length) return false;
		return this.tokens[this.current + n].type === type;
	}

	private advance(): Token {
		if (!this.isAtEnd()) this.current++;
		return this.previous();
	}

	private isAtEnd(): boolean {
		return this.peek().type === TokenType.EOF;
	}

	private peek(): Token {
		return this.tokens[this.current];
	}

	private previous(): Token {
		return this.tokens[this.current - 1];
	}

	private error(token: Token, message: string): ParseError {
		return new ParseError(token, message);
	}

	private isJoinToken(): boolean {
		return this.check(TokenType.JOIN) ||
			this.check(TokenType.INNER) ||
			this.check(TokenType.LEFT) ||
			this.check(TokenType.RIGHT) ||
			this.check(TokenType.FULL) ||
			this.check(TokenType.CROSS);
	}

	private isEndOfClause(): boolean {
		const token = this.peek().type;
		return token === TokenType.FROM ||
			token === TokenType.WHERE ||
			token === TokenType.GROUP ||
			token === TokenType.HAVING ||
			token === TokenType.ORDER ||
			token === TokenType.LIMIT ||
			token === TokenType.UNION ||
			token === TokenType.SEMICOLON ||
			token === TokenType.EOF;
	}

	// --- Statement Parsing Stubs ---

	/** @internal */
	private updateStatement(): AST.UpdateStmt {
		const table = this.tableIdentifier();

		this.consume(TokenType.SET, "Expected 'SET' after table name in UPDATE.");

		const assignments: { column: string; value: AST.Expression }[] = [];
		do {
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected column name in SET clause.");
			}
			const column = this.advance().lexeme;
			this.consume(TokenType.EQUAL, "Expected '=' after column name in SET clause.");
			const value = this.expression();
			assignments.push({ column, value });
		} while (this.match(TokenType.COMMA));

		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}

		// Optional ON CONFLICT and RETURNING clauses (placeholders)
		// let onConflict: ConflictResolution | undefined;
		// let returning: ResultColumn[] | undefined;

		return {
			type: 'update',
			table,
			assignments,
			where,
			// onConflict,
			// returning,
		};
	}

	/** @internal */
	private deleteStatement(): AST.DeleteStmt {
		// Optional FROM keyword (SQLite allows omitting it)
		this.matchKeyword('FROM');

		const table = this.tableIdentifier();

		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}

		// Optional RETURNING clause (placeholder for now)
		// let returning: ResultColumn[] | undefined;
		// if (this.match(TokenType.RETURNING)) {
		//   returning = this.columnList();
		// }

		return {
			type: 'delete',
			table,
			where,
			// returning,
		};
	}

	/** @internal */
	private createStatement(): AST.CreateTableStmt | AST.CreateIndexStmt | AST.CreateViewStmt {
		// CREATE keyword consumed by main `statement` method
		if (this.peekKeyword('TABLE')) {
			this.consumeKeyword('TABLE', "Expected 'TABLE' after CREATE."); // Consume the token
			return this.createTableStatement();
		} else if (this.peekKeyword('INDEX')) {
			this.consumeKeyword('INDEX', "Expected 'INDEX' after CREATE.");
			return this.createIndexStatement();
		} else if (this.peekKeyword('VIEW')) {
			this.consumeKeyword('VIEW', "Expected 'VIEW' after CREATE.");
			return this.createViewStatement();
		} else if (this.peekKeyword('UNIQUE')) {
			this.consumeKeyword('UNIQUE', "Expected 'UNIQUE' after CREATE.");
			// Handle CREATE UNIQUE INDEX ...
			this.consumeKeyword('INDEX', "Expected 'INDEX' after CREATE UNIQUE.");
			return this.createIndexStatement(true); // Pass flag indicating unique
		}
		throw this.error(this.peek(), "Expected TABLE, [UNIQUE] INDEX, VIEW, or VIRTUAL after CREATE.");
	}

	/**
	 * Parse CREATE TABLE statement
	 * @returns AST for CREATE TABLE
	 */
	private createTableStatement(): AST.CreateTableStmt {
		// TABLE keyword consumed by createStatement
		let isTemporary = false;
		if (this.peekKeyword('TEMP') || this.peekKeyword('TEMPORARY')) {
			isTemporary = true;
			this.advance(); // Consume TEMP or TEMPORARY
		}

		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const table = this.tableIdentifier();

		let columns: AST.ColumnDef[] = [];
		let constraints: AST.TableConstraint[] = [];
		let withoutRowid = false;

		if (this.check(TokenType.LPAREN)) {
			this.consume(TokenType.LPAREN, "Expected '(' to start table definition."); // Consume LPAREN
			// Parse column definitions and table constraints
			do {
				// Check if it's a table constraint (PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY)
				if (this.peekKeyword('PRIMARY') || this.peekKeyword('UNIQUE') || this.peekKeyword('CHECK') || this.peekKeyword('FOREIGN') || this.peekKeyword('CONSTRAINT')) {
					constraints.push(this.tableConstraint());
				} else {
					// Otherwise, it's a column definition
					columns.push(this.columnDefinition());
				}
			} while (this.match(TokenType.COMMA));

			this.consume(TokenType.RPAREN, "Expected ')' after table definition.");

			// Check for WITHOUT ROWID option
			if (this.matchKeyword('WITHOUT')) { // matchKeyword consumes
				this.consumeKeyword('ROWID', "Expected 'ROWID' after 'WITHOUT'.");
				withoutRowid = true;
			}
		} else if (this.matchKeyword('AS')) {
			// CREATE TABLE ... AS SELECT ... (Not implemented fully yet)
			const select = this.selectStatement();
			throw new Error('CREATE TABLE AS SELECT is not fully implemented.');
			// Need to infer columns from SELECT statement
			// return { type: 'createTable', table, ifNotExists, isTemporary, select };
		} else {
			throw this.error(this.peek(), "Expected '(' or 'AS' after table name.");
		}

		return {
			type: 'createTable',
			table,
			ifNotExists,
			columns,
			constraints,
			withoutRowid,
			isTemporary,
		};
	}

	/**
	 * Parse CREATE INDEX statement
	 * @param isUnique Flag indicating if UNIQUE keyword was already parsed
	 * @returns AST for CREATE INDEX
	 */
	private createIndexStatement(isUnique = false): AST.CreateIndexStmt {
		// INDEX keyword consumed by createStatement (or CREATE UNIQUE INDEX logic)
		// Handle if UNIQUE was parsed *before* INDEX (e.g., CREATE UNIQUE INDEX)
		if (!isUnique && this.peekKeyword('UNIQUE')) {
			isUnique = true;
			this.advance(); // Consume UNIQUE
		}

		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const index = this.tableIdentifier(); // Index name follows same identifier rules

		this.consumeKeyword('ON', "Expected 'ON' after index name."); // consumeKeyword still useful here

		const table = this.tableIdentifier();

		this.consume(TokenType.LPAREN, "Expected '(' before indexed columns.");
		const columns = this.indexedColumnList();
		this.consume(TokenType.RPAREN, "Expected ')' after indexed columns.");

		let where: AST.Expression | undefined;
		if (this.matchKeyword('WHERE')) { // Use matchKeyword
			where = this.expression();
		}

		return {
			type: 'createIndex',
			index,
			table,
			ifNotExists,
			columns,
			where,
			isUnique, // Use the determined value
		};
	}

	/**
	 * Parse CREATE VIEW statement
	 * @returns AST for CREATE VIEW
	 */
	private createViewStatement(): AST.CreateViewStmt {
		// VIEW keyword consumed by createStatement
		let isTemporary = false;
		if (this.peekKeyword('TEMP') || this.peekKeyword('TEMPORARY')) {
			isTemporary = true;
			this.advance(); // Consume TEMP or TEMPORARY
		}

		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const view = this.tableIdentifier(); // Views use the same identifier structure

		let columns: string[] | undefined;
		if (this.check(TokenType.LPAREN)) {
			this.consume(TokenType.LPAREN, "Expected '(' to start view column list.");
			columns = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					if (!this.check(TokenType.IDENTIFIER)) {
						throw this.error(this.peek(), "Expected column name in view column list.");
					}
					columns.push(this.advance().lexeme);
				} while (this.match(TokenType.COMMA));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after view column list.");
		}

		this.consumeKeyword('AS', "Expected 'AS' before SELECT statement for CREATE VIEW."); // consumeKeyword ok here

		const select = this.selectStatement();

		return {
			type: 'createView',
			view,
			ifNotExists,
			columns,
			select,
			isTemporary,
		};
	}

	/**
	 * Parse DROP statement
	 * @returns AST for DROP statement
	 */
	private dropStatement(): AST.DropStmt {
		// DROP keyword consumed by main `statement` method
		let objectType: 'table' | 'view' | 'index' | 'trigger';

		if (this.peekKeyword('TABLE')) {
			this.consumeKeyword('TABLE', "Expected TABLE after DROP.");
			objectType = 'table';
		} else if (this.peekKeyword('VIEW')) {
			this.consumeKeyword('VIEW', "Expected VIEW after DROP.");
			objectType = 'view';
		} else if (this.peekKeyword('INDEX')) {
			this.consumeKeyword('INDEX', "Expected INDEX after DROP.");
			objectType = 'index';
			// } else if (this.matchKeyword('TRIGGER')) { // Need TRIGGER token
			//   objectType = 'trigger';
		} else {
			throw this.error(this.peek(), "Expected TABLE, VIEW, or INDEX after DROP.");
		}

		let ifExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF'.");
			ifExists = true;
		}

		const name = this.tableIdentifier(); // Use tableIdentifier for schema.name structure

		return {
			type: 'drop',
			objectType,
			name,
			ifExists,
		};
	}

	/**
	 * Parse ALTER TABLE statement
	 * @returns AST for ALTER TABLE statement
	 */
	private alterTableStatement(): AST.AlterTableStmt {
		// ALTER keyword consumed by main `statement` method
		this.consumeKeyword('TABLE', "Expected 'TABLE' after ALTER.");

		const table = this.tableIdentifier();

		let action: AST.AlterTableAction;

		if (this.peekKeyword('RENAME')) {
			this.consumeKeyword('RENAME', "Expected RENAME.");
			if (this.matchKeyword('COLUMN')) {
				// RENAME COLUMN old TO new
				const oldName = this.consumeIdentifier("Expected old column name after RENAME COLUMN.");
				this.consumeKeyword('TO', "Expected 'TO' after old column name.");
				const newName = this.consumeIdentifier("Expected new column name after TO.");
				action = { type: 'renameColumn', oldName, newName };
			} else {
				// RENAME TO new
				this.consumeKeyword('TO', "Expected 'TO' after RENAME.");
				const newName = this.consumeIdentifier("Expected new table name after RENAME TO.");
				action = { type: 'renameTable', newName };
			}
		} else if (this.peekKeyword('ADD')) {
			this.consumeKeyword('ADD', "Expected ADD.");
			// ADD [COLUMN] column_def
			this.matchKeyword('COLUMN'); // Optional COLUMN keyword
			const column = this.columnDefinition();
			action = { type: 'addColumn', column };
		} else if (this.peekKeyword('DROP')) {
			this.consumeKeyword('DROP', "Expected DROP.");
			// DROP [COLUMN] column_name
			this.matchKeyword('COLUMN'); // Optional COLUMN keyword
			const name = this.consumeIdentifier("Expected column name after DROP COLUMN.");
			action = { type: 'dropColumn', name };
		} else {
			throw this.error(this.peek(), "Expected RENAME, ADD, or DROP after table name in ALTER TABLE.");
		}

		return {
			type: 'alterTable',
			table,
			action,
		};
	}

	/**
	 * Parse BEGIN statement
	 * @returns AST for BEGIN statement
	 */
	private beginStatement(): AST.BeginStmt {
		// BEGIN keyword consumed by main `statement` method
		let mode: 'deferred' | 'immediate' | 'exclusive' | undefined;
		if (this.peekKeyword('DEFERRED')) {
			this.advance();
			mode = 'deferred';
		} else if (this.peekKeyword('IMMEDIATE')) {
			this.advance();
			mode = 'immediate';
		} else if (this.peekKeyword('EXCLUSIVE')) {
			this.advance();
			mode = 'exclusive';
		}

		// Optional TRANSACTION keyword
		this.matchKeyword('TRANSACTION');

		return { type: 'begin', mode };
	}

	/**
	 * Parse COMMIT statement
	 * @returns AST for COMMIT statement
	 */
	private commitStatement(): AST.CommitStmt {
		// COMMIT keyword consumed by main `statement` method
		// Optional TRANSACTION keyword
		this.matchKeyword('TRANSACTION');
		return { type: 'commit' };
	}

	/**
	 * Parse ROLLBACK statement
	 * @returns AST for ROLLBACK statement
	 */
	private rollbackStatement(): AST.RollbackStmt {
		// ROLLBACK keyword consumed by main `statement` method
		// Optional TRANSACTION keyword
		this.matchKeyword('TRANSACTION');

		// Optional TO [SAVEPOINT] savepoint_name
		let savepoint: string | undefined;
		if (this.matchKeyword('TO')) {
			// Optional SAVEPOINT keyword
			this.matchKeyword('SAVEPOINT');
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected savepoint name after ROLLBACK TO.");
			}
			savepoint = this.advance().lexeme;
		}
		return { type: 'rollback', savepoint };
	}

	/**
	 * Parse SAVEPOINT statement
	 * @returns AST for SAVEPOINT statement
	 */
	private savepointStatement(): AST.SavepointStmt {
		// SAVEPOINT keyword consumed by main `statement` method
		const name = this.consumeIdentifier("Expected savepoint name after SAVEPOINT.");
		return { type: 'savepoint', name };
	}

	/**
	 * Parse RELEASE statement
	 * @returns AST for RELEASE statement
	 */
	private releaseStatement(): AST.ReleaseStmt {
		// RELEASE keyword consumed by main `statement` method
		// Optional SAVEPOINT keyword
		this.matchKeyword('SAVEPOINT');
		const name = this.consumeIdentifier("Expected savepoint name after RELEASE [SAVEPOINT].");
		return { type: 'release', savepoint: name };
	}

	/**
	 * Parse PRAGMA statement
	 * @returns AST for PRAGMA statement
	 */
	private pragmaStatement(): AST.PragmaStmt {
		// PRAGMA keyword consumed by statement()
		const name = this.consumeIdentifier("Expected pragma name.");

		let value: AST.LiteralExpr | AST.IdentifierExpr | undefined;
		if (this.match(TokenType.EQUAL)) {
			// Parse the value after '='
			if (this.check(TokenType.IDENTIFIER)) {
				value = { type: 'identifier', name: this.advance().lexeme };
			} else if (this.match(TokenType.STRING, TokenType.INTEGER, TokenType.FLOAT, TokenType.NULL)) {
				const token = this.previous();
				value = { type: 'literal', value: token.type === TokenType.NULL ? null : token.literal };
			} else if (this.match(TokenType.MINUS)) { // Handle negative numbers
				if (this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT)) {
					const token = this.advance();
					value = { type: 'literal', value: -token.literal };
				} else {
					throw this.error(this.peek(), "Expected number after '-'.");
				}
			} else {
				throw this.error(this.peek(), "Expected pragma value (identifier, string, number, or NULL).");
			}
		} else {
			// TODO: Handle PRAGMA name; syntax if needed (no value)
			// For now, assume assignment format is required for our pragmas
			// If no value is needed, the check above will fail. Let's require '=' for now.
			throw this.error(this.peek(), "Expected '=' after pragma name.");

		}

		return { type: 'pragma', name: name.toLowerCase(), value }; // Store name lowercased
	}

	// --- Supporting Clause / Definition Parsers ---

	/** @internal Parses a comma-separated list of indexed columns */
	private indexedColumnList(): AST.IndexedColumn[] {
		const columns: AST.IndexedColumn[] = [];
		do {
			columns.push(this.indexedColumn());
		} while (this.match(TokenType.COMMA));
		return columns;
	}

	/** @internal Parses a single indexed column definition */
	private indexedColumn(): AST.IndexedColumn {
		// SQLite allows expressions in index definitions, so parse a full expression first
		const expr = this.expression();

		// However, for simplicity and common usage, let's extract the name if it's just a simple column identifier
		let name: string | undefined;
		if (expr.type === 'column' && !expr.table && !expr.schema) {
			name = expr.name;
		}

		// TODO: Parse COLLATE collation_name if needed
		// let collation: string | undefined;
		// if (this.match(TokenType.COLLATE)) { ... }

		let direction: 'asc' | 'desc' | undefined;
		if (this.match(TokenType.ASC)) {
			direction = 'asc';
		} else if (this.match(TokenType.DESC)) {
			direction = 'desc';
		}

		if (name) {
			// If it was a simple column name, prefer the name field
			return { name, direction /*, collation */ };
		} else {
			// Otherwise, store the parsed expression
			return { expr, direction /*, collation */ };
		}
	}

	/** @internal Helper to consume an IDENTIFIER token and return its lexeme */
	private consumeIdentifier(errorMessage: string): string {
		if (!this.check(TokenType.IDENTIFIER)) {
			throw this.error(this.peek(), errorMessage);
		}
		return this.advance().lexeme;
	}

	// --- Stubs for required helpers (implement fully for CREATE TABLE) ---

	/** @internal Parses a column definition */
	private columnDefinition(): AST.ColumnDef {
		const name = this.consumeIdentifier("Expected column name.");

		let dataType: string | undefined;
		// Simple type name parsing (e.g., INTEGER, TEXT, VARCHAR(10))
		if (this.check(TokenType.IDENTIFIER)) {
			dataType = this.advance().lexeme;
			// Optionally parse type parameters like (10, 2) for NUMERIC etc.
			if (this.match(TokenType.LPAREN)) {
				dataType += '(';
				let parenLevel = 1; // Handle nested parentheses
				while (parenLevel > 0 && !this.isAtEnd()) {
					const token = this.peek();
					if (token.type === TokenType.LPAREN) parenLevel++;
					if (token.type === TokenType.RPAREN) parenLevel--;
					if (parenLevel > 0) { // Don't add the closing parenthesis here
						dataType += this.advance().lexeme;
					}
				}
				dataType += ')';
				this.consume(TokenType.RPAREN, "Expected ')' after type parameters.");
			}
		}

		const constraints = this.columnConstraintList();

		return { name, dataType, constraints };
	}

	/** @internal Parses column constraints */
	private columnConstraintList(): AST.ColumnConstraint[] {
		const constraints: AST.ColumnConstraint[] = [];
		while (this.isColumnConstraintStart()) {
			constraints.push(this.columnConstraint());
		}
		return constraints;
	}

	/** @internal Checks if the current token can start a column constraint */
	private isColumnConstraintStart(): boolean {
		return this.check(TokenType.CONSTRAINT) ||
			this.check(TokenType.PRIMARY) ||
			this.check(TokenType.NOT) || // NOT NULL
			this.check(TokenType.UNIQUE) ||
			this.check(TokenType.CHECK) ||
			this.check(TokenType.DEFAULT) ||
			this.check(TokenType.COLLATE) || // Added
			this.check(TokenType.REFERENCES) || // FOREIGN KEY
			this.check(TokenType.GENERATED); // Added
	}

	/** @internal Parses a single column constraint */
	private columnConstraint(): AST.ColumnConstraint {
		let name: string | undefined;
		if (this.match(TokenType.CONSTRAINT)) {
			name = this.consumeIdentifier("Expected constraint name after CONSTRAINT.");
		}

		if (this.match(TokenType.PRIMARY)) {
			this.consume(TokenType.KEY, "Expected KEY after PRIMARY.");
			// Parse optional direction for column PK
			const direction = this.match(TokenType.ASC) ? 'asc' : this.match(TokenType.DESC) ? 'desc' : undefined;
			const onConflict = this.parseConflictClause();
			const autoincrement = this.match(TokenType.AUTOINCREMENT);
			return { type: 'primaryKey', name, onConflict, autoincrement, direction };
		} else if (this.match(TokenType.NOT)) {
			this.consume(TokenType.NULL, "Expected NULL after NOT.");
			const onConflict = this.parseConflictClause();
			return { type: 'notNull', name, onConflict };
		} else if (this.match(TokenType.UNIQUE)) {
			const onConflict = this.parseConflictClause();
			return { type: 'unique', name, onConflict };
		} else if (this.match(TokenType.CHECK)) {
			this.consume(TokenType.LPAREN, "Expected '(' after CHECK.");
			const expr = this.expression();
			this.consume(TokenType.RPAREN, "Expected ')' after CHECK expression.");
			return { type: 'check', name, expr };
		} else if (this.match(TokenType.DEFAULT)) {
			// Handle signed numbers, CURRENT_TIME, etc. more explicitly if needed
			// For now, expression handles literals, parenthesized expr might work for others
			const expr = this.expression();
			return { type: 'default', name, expr };
		} else if (this.match(TokenType.COLLATE)) {
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected collation name after COLLATE.");
			}
			const collation = this.advance().lexeme;
			return { type: 'collate', name, collation };
		} else if (this.match(TokenType.REFERENCES)) { // Foreign key defined inline
			const fkClause = this.foreignKeyClause();
			return { type: 'foreignKey', name, foreignKey: fkClause };
		} else if (this.match(TokenType.GENERATED)) {
			this.consume(TokenType.ALWAYS, "Expected ALWAYS after GENERATED."); // Need ALWAYS token? Assume AS for now.
			this.consume(TokenType.AS, "Expected AS after GENERATED ALWAYS.");
			this.consume(TokenType.LPAREN, "Expected '(' after AS.");
			const expr = this.expression();
			this.consume(TokenType.RPAREN, "Expected ')' after generated expression.");
			let stored = false;
			if (this.match(TokenType.STORED)) {
				stored = true;
			} else {
				this.match(TokenType.VIRTUAL); // Optional VIRTUAL keyword
			}
			return { type: 'generated', name, generated: { expr, stored } };
		}


		throw this.error(this.peek(), "Expected column constraint type (PRIMARY KEY, NOT NULL, UNIQUE, CHECK, DEFAULT, COLLATE, REFERENCES, GENERATED).");
	}

	/** @internal Parses a table constraint */
	private tableConstraint(): AST.TableConstraint {
		let name: string | undefined;
		if (this.match(TokenType.CONSTRAINT)) {
			name = this.consumeIdentifier("Expected constraint name after CONSTRAINT.");
		}

		if (this.match(TokenType.PRIMARY)) {
			this.consume(TokenType.KEY, "Expected KEY after PRIMARY.");
			this.consume(TokenType.LPAREN, "Expected '(' before PRIMARY KEY columns.");
			// Use updated identifierListWithDirection
			const columns = this.identifierListWithDirection();
			this.consume(TokenType.RPAREN, "Expected ')' after PRIMARY KEY columns.");
			const onConflict = this.parseConflictClause();
			return { type: 'primaryKey', name, columns, onConflict };
		} else if (this.match(TokenType.UNIQUE)) {
			this.consume(TokenType.LPAREN, "Expected '(' before UNIQUE columns.");
			// Assume UNIQUE columns don't typically have direction specified, use simple list
			// If needed later, could use identifierListWithDirection here too.
			const columnsSimple = this.identifierList();
			const columns = columnsSimple.map(name => ({ name })); // Convert to new format
			this.consume(TokenType.RPAREN, "Expected ')' after UNIQUE columns.");
			const onConflict = this.parseConflictClause();
			return { type: 'unique', name, columns, onConflict };
		} else if (this.match(TokenType.CHECK)) {
			this.consume(TokenType.LPAREN, "Expected '(' after CHECK.");
			const expr = this.expression();
			this.consume(TokenType.RPAREN, "Expected ')' after CHECK expression.");
			return { type: 'check', name, expr };
		} else if (this.match(TokenType.FOREIGN)) {
			this.consume(TokenType.KEY, "Expected KEY after FOREIGN.");
			this.consume(TokenType.LPAREN, "Expected '(' before FOREIGN KEY columns.");
			const columns = this.identifierList().map(name => ({ name }));
			this.consume(TokenType.RPAREN, "Expected ')' after FOREIGN KEY columns.");
			const fkClause = this.foreignKeyClause();
			return { type: 'foreignKey', name, columns, foreignKey: fkClause };
		}

		throw this.error(this.peek(), "Expected table constraint type (PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY).");
	}

	/** @internal Parses a foreign key clause */
	private foreignKeyClause(): AST.ForeignKeyClause {
		this.consume(TokenType.REFERENCES, "Expected REFERENCES for foreign key.");
		const table = this.consumeIdentifier("Expected foreign table name.");
		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = this.identifierList();
			this.consume(TokenType.RPAREN, "Expected ')' after foreign columns.");
		}

		let onDelete: AST.ForeignKeyAction | undefined;
		let onUpdate: AST.ForeignKeyAction | undefined;
		let deferrable: boolean | undefined;
		let initiallyDeferred: boolean | undefined;

		while (this.check(TokenType.ON) || this.check(TokenType.DEFERRABLE) || this.check(TokenType.NOT)) {
			if (this.match(TokenType.ON)) {
				if (this.match(TokenType.DELETE)) {
					onDelete = this.parseForeignKeyAction();
				} else if (this.match(TokenType.UPDATE)) {
					onUpdate = this.parseForeignKeyAction();
				} else {
					throw this.error(this.peek(), "Expected DELETE or UPDATE after ON.");
				}
			} else if (this.match(TokenType.DEFERRABLE)) {
				deferrable = true;
				if (this.match(TokenType.INITIALLY)) {
					if (this.match(TokenType.DEFERRED)) {
						initiallyDeferred = true;
					} else if (this.match(TokenType.IMMEDIATE)) {
						initiallyDeferred = false;
					} else {
						throw this.error(this.peek(), "Expected DEFERRED or IMMEDIATE after INITIALLY.");
					}
				}
			} else if (this.match(TokenType.NOT)) {
				this.consume(TokenType.DEFERRABLE, "Expected DEFERRABLE after NOT.");
				deferrable = false;
				if (this.match(TokenType.INITIALLY)) {
					if (this.match(TokenType.DEFERRED)) {
						initiallyDeferred = true; // NOT DEFERRABLE INITIALLY DEFERRED doesn't make sense but parse it
					} else if (this.match(TokenType.IMMEDIATE)) {
						initiallyDeferred = false;
					} else {
						throw this.error(this.peek(), "Expected DEFERRED or IMMEDIATE after INITIALLY.");
					}
				}
			} else {
				break; // No more FK clauses
			}
		}

		return { table, columns, onDelete, onUpdate, deferrable, initiallyDeferred };
	}

	/** @internal Parses the ON CONFLICT clause */
	private parseConflictClause(): ConflictResolution | undefined {
		if (this.match(TokenType.ON)) {
			this.consume(TokenType.CONFLICT, "Expected CONFLICT after ON.");
			if (this.match(TokenType.ROLLBACK)) return ConflictResolution.ROLLBACK;
			if (this.match(TokenType.ABORT)) return ConflictResolution.ABORT;
			if (this.match(TokenType.FAIL)) return ConflictResolution.FAIL;
			if (this.match(TokenType.IGNORE)) return ConflictResolution.IGNORE;
			if (this.match(TokenType.REPLACE)) return ConflictResolution.REPLACE;
			throw this.error(this.peek(), "Expected conflict resolution algorithm (ROLLBACK, ABORT, FAIL, IGNORE, REPLACE).");
		}
		return undefined;
	}

	/** @internal Parses the foreign key action */
	private parseForeignKeyAction(): AST.ForeignKeyAction {
		if (this.match(TokenType.SET)) {
			if (this.match(TokenType.NULL)) return 'setNull';
			if (this.match(TokenType.DEFAULT)) return 'setDefault';
			throw this.error(this.peek(), "Expected NULL or DEFAULT after SET.");
		} else if (this.match(TokenType.CASCADE)) {
			return 'cascade';
		} else if (this.match(TokenType.RESTRICT)) {
			return 'restrict';
		} else if (this.match(TokenType.NO)) {
			this.consume(TokenType.ACTION, "Expected ACTION after NO.");
			return 'noAction';
		}
		throw this.error(this.peek(), "Expected foreign key action (SET NULL, SET DEFAULT, CASCADE, RESTRICT, NO ACTION).");
	}

	/** @internal Parses a comma-separated list of identifiers, optionally with ASC/DESC */
	private identifierList(): string[] {
		const identifiers: string[] = [];
		do {
			identifiers.push(this.consumeIdentifier("Expected identifier in list."));
		} while (this.match(TokenType.COMMA));
		return identifiers;
	}

	/** @internal Parses a comma-separated list of identifiers, optionally with ASC/DESC */
	private identifierListWithDirection(): { name: string; direction?: 'asc' | 'desc' }[] {
		const identifiers: { name: string; direction?: 'asc' | 'desc' }[] = [];
		do {
			const name = this.consumeIdentifier("Expected identifier in list.");
			const direction = this.match(TokenType.ASC) ? 'asc' : this.match(TokenType.DESC) ? 'desc' : undefined;
			identifiers.push({ name, direction });
		} while (this.match(TokenType.COMMA));
		return identifiers;
	}

	// --- Helper method to peek keywords case-insensitively ---
	private peekKeyword(keyword: string): boolean {
		if (this.isAtEnd()) return false;
		const token = this.peek();
		// Check if it's an identifier with the correct lexeme or the specific keyword token
		return (token.type === TokenType.IDENTIFIER && token.lexeme.toUpperCase() === keyword) ||
			(token.type === TokenType[keyword.toUpperCase() as keyof typeof TokenType]);
	}

	// --- Helper method to match keywords case-insensitively ---
	private matchKeyword(keyword: string): boolean {
		if (this.isAtEnd()) return false; // Added check
		if (this.peekKeyword(keyword)) {
			this.advance();
			return true;
		}
		return false;
	}

	// --- Helper method to consume keywords case-insensitively ---
	private consumeKeyword(keyword: string, message: string): Token {
		if (this.peekKeyword(keyword)) {
			return this.advance();
		}
		throw this.error(this.peek(), message);
	}
}
