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
			return this.statement();
		} catch (e) {
			if (e instanceof ParseError) {
				throw e;
			}
			// Unknown error
			throw new Error(`Parser error: ${e}`);
		}
	}

	/**
	 * Parse a single SQL statement
	 */
	private statement(): AST.AstNode {
		if (this.match(TokenType.SELECT)) {
			return this.selectStatement();
		}
		if (this.match(TokenType.INSERT)) {
			return this.insertStatement();
		}
		if (this.match(TokenType.UPDATE)) {
			return this.updateStatement();
		}
		if (this.match(TokenType.DELETE)) {
			return this.deleteStatement();
		}
		if (this.match(TokenType.CREATE)) {
			return this.createStatement();
		}
		if (this.match(TokenType.DROP)) {
			return this.dropStatement();
		}
		if (this.match(TokenType.ALTER)) {
			return this.alterTableStatement();
		}
		if (this.match(TokenType.BEGIN)) {
			return this.beginStatement();
		}
		if (this.match(TokenType.COMMIT)) {
			return this.commitStatement();
		}
		if (this.match(TokenType.ROLLBACK)) {
			return this.rollbackStatement();
		}
		if (this.match(TokenType.SAVEPOINT)) {
			return this.savepointStatement();
		}
		if (this.match(TokenType.RELEASE)) {
			return this.releaseStatement();
		}

		// TODO: Add other statement types (ALTER, DROP, CREATE INDEX/VIEW/VTAB, BEGIN/COMMIT/ROLLBACK)

		throw this.error(this.peek(), 'Expected statement. Currently supporting SELECT and INSERT.');
	}

	/**
	 * Parse an INSERT statement
	 * @returns AST for the INSERT statement
	 */
	insertStatement(): AST.InsertStmt {
		// INTO keyword is optional in SQLite
		this.match(TokenType.INTO); // Handle missing TokenType.INTO gracefully

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
		const distinct = this.match(TokenType.DISTINCT);
		const all = !distinct && this.match(TokenType.ALL);

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
	 * Parse a single table source
	 */
	private tableSource(): AST.TableSource {
		// Parse table name
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
		this.match(TokenType.FROM);

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
	private createStatement(): AST.CreateTableStmt | AST.CreateIndexStmt | AST.CreateViewStmt | AST.CreateVirtualTableStmt {
		if (this.match(TokenType.TABLE)) {
			return this.createTableStatement();
		} else if (this.match(TokenType.INDEX)) {
			return this.createIndexStatement();
		} else if (this.match(TokenType.VIEW)) {
			return this.createViewStatement();
		} else if (this.match(TokenType.VIRTUAL)) {
			this.consume(TokenType.TABLE, "Expected 'TABLE' after 'VIRTUAL'.");
			return this.createVirtualTableStatement();
		}
		throw this.error(this.peek(), "Expected TABLE, INDEX, VIEW, or VIRTUAL after CREATE.");
	}

	/** @internal */
	private createTableStatement(): AST.CreateTableStmt {
		const isTemporary = this.match(TokenType.TEMP) || this.match(TokenType.TEMPORARY);
		// TABLE keyword was already consumed by createStatement

		const ifNotExists = this.match(TokenType.IF) && this.match(TokenType.NOT) && this.consume(TokenType.EXISTS, "Expected 'EXISTS' after 'IF NOT'.");

		const table = this.tableIdentifier();

		let columns: AST.ColumnDef[] = [];
		let constraints: AST.TableConstraint[] = [];
		let withoutRowid = false;

		if (this.match(TokenType.LPAREN)) {
			// Parse column definitions and table constraints
			do {
				// Check if it's a table constraint (PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY)
				if (this.check(TokenType.PRIMARY) || this.check(TokenType.UNIQUE) || this.check(TokenType.CHECK) || this.check(TokenType.FOREIGN)) {
					constraints.push(this.tableConstraint());
				} else {
					// Otherwise, it's a column definition
					columns.push(this.columnDefinition());
				}
			} while (this.match(TokenType.COMMA));

			this.consume(TokenType.RPAREN, "Expected ')' after table definition.");

			// Check for WITHOUT ROWID option
			if (this.match(TokenType.WITHOUT)) {
				this.consume(TokenType.ROWID, "Expected 'ROWID' after 'WITHOUT'.");
				withoutRowid = true;
			}
		} else if (this.match(TokenType.AS)) {
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

	/** @internal */
	private createIndexStatement(): AST.CreateIndexStmt {
		const isUnique = this.match(TokenType.UNIQUE);
		this.consume(TokenType.INDEX, "Expected 'INDEX' after CREATE [UNIQUE].");

		const ifNotExists = this.match(TokenType.IF) && this.match(TokenType.NOT) && this.consume(TokenType.EXISTS, "Expected 'EXISTS' after 'IF NOT'.");

		const index = this.tableIdentifier(); // Index name follows same identifier rules

		this.consume(TokenType.ON, "Expected 'ON' after index name.");

		const table = this.tableIdentifier();

		this.consume(TokenType.LPAREN, "Expected '(' before indexed columns.");
		const columns = this.indexedColumnList();
		this.consume(TokenType.RPAREN, "Expected ')' after indexed columns.");

		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}

		return {
			type: 'createIndex',
			index,
			table,
			ifNotExists,
			columns,
			where,
			isUnique,
		};
	}

	/** @internal */
	private createViewStatement(): AST.CreateViewStmt {
		const isTemporary = this.match(TokenType.TEMP) || this.match(TokenType.TEMPORARY); // TEMP or TEMPORARY
		this.consume(TokenType.VIEW, "Expected 'VIEW' after CREATE [TEMP].");

		const ifNotExists = this.match(TokenType.IF) && this.match(TokenType.NOT) && this.consume(TokenType.EXISTS, "Expected 'EXISTS' after 'IF NOT'.");

		const view = this.tableIdentifier(); // Views use the same identifier structure

		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = [];
			do {
				if (!this.check(TokenType.IDENTIFIER)) {
					throw this.error(this.peek(), "Expected column name in view column list.");
				}
				columns.push(this.advance().lexeme);
			} while (this.match(TokenType.COMMA));
			this.consume(TokenType.RPAREN, "Expected ')' after view column list.");
		}

		this.consume(TokenType.AS, "Expected 'AS' before SELECT statement for CREATE VIEW.");

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

	/** @internal */
	private createVirtualTableStatement(): AST.CreateVirtualTableStmt {
		const ifNotExists = this.match(TokenType.IF) && this.match(TokenType.NOT) && this.consume(TokenType.EXISTS, "Expected 'EXISTS' after 'IF NOT'.");

		const table = this.tableIdentifier();

		this.consume(TokenType.USING, "Expected 'USING' after table name for CREATE VIRTUAL TABLE.");

		if (!this.check(TokenType.IDENTIFIER)) {
			throw this.error(this.peek(), "Expected module name after 'USING'.");
		}
		const moduleName = this.advance().lexeme;

		const moduleArgs: string[] = [];
		if (this.match(TokenType.LPAREN)) {
			if (!this.check(TokenType.RPAREN)) { // Handle empty args list
				do {
					// Module arguments are often treated as unparsed strings/tokens
					// We'll capture the lexeme of the next token, regardless of type (except comma/paren)
					const token = this.peek();
					if (token.type === TokenType.COMMA || token.type === TokenType.RPAREN || token.type === TokenType.EOF) {
						throw this.error(token, "Expected module argument.");
					}
					// Consume the argument token(s). A simple approach is to just take the lexeme.
					// More complex arguments might require consuming multiple tokens.
					// For now, just take the next token's lexeme.
					moduleArgs.push(this.advance().lexeme);
					// TODO: Handle quoted arguments or more complex token sequences if needed.

				} while (this.match(TokenType.COMMA));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after module arguments.");
		}

		return {
			type: 'createVirtualTable',
			ifNotExists,
			table,
			moduleName,
			moduleArgs,
		};
	}

	/** @internal */
	private dropStatement(): AST.DropStmt {
		let objectType: 'table' | 'view' | 'index' | 'trigger';

		if (this.match(TokenType.TABLE)) {
			objectType = 'table';
		} else if (this.match(TokenType.VIEW)) {
			objectType = 'view';
		} else if (this.match(TokenType.INDEX)) {
			objectType = 'index';
			// } else if (this.match(TokenType.TRIGGER)) { // Need TRIGGER token
			//   objectType = 'trigger';
		} else {
			throw this.error(this.peek(), "Expected TABLE, VIEW, or INDEX after DROP.");
		}

		const ifExists = this.match(TokenType.IF) && this.consume(TokenType.EXISTS, "Expected 'EXISTS' after 'IF'.");

		const name = this.tableIdentifier(); // Use tableIdentifier for schema.name structure

		return {
			type: 'drop',
			objectType,
			name,
			ifExists,
		};
	}

	/** @internal */
	private alterTableStatement(): AST.AlterTableStmt {
		this.consume(TokenType.TABLE, "Expected 'TABLE' after ALTER.");

		const table = this.tableIdentifier();

		let action: AST.AlterTableAction;

		if (this.match(TokenType.RENAME)) {
			if (this.match(TokenType.COLUMN)) {
				// RENAME COLUMN old TO new
				const oldName = this.consumeIdentifier("Expected old column name after RENAME COLUMN.");
				this.consume(TokenType.TO, "Expected 'TO' after old column name.");
				const newName = this.consumeIdentifier("Expected new column name after TO.");
				action = { type: 'renameColumn', oldName, newName };
			} else {
				// RENAME TO new
				this.consume(TokenType.TO, "Expected 'TO' after RENAME.");
				const newName = this.consumeIdentifier("Expected new table name after RENAME TO.");
				action = { type: 'renameTable', newName };
			}
		} else if (this.match(TokenType.ADD)) {
			// ADD [COLUMN] column_def
			this.match(TokenType.COLUMN); // Optional COLUMN keyword
			const column = this.columnDefinition();
			action = { type: 'addColumn', column };
		} else if (this.match(TokenType.DROP)) {
			// DROP [COLUMN] column_name
			this.match(TokenType.COLUMN); // Optional COLUMN keyword
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

	/** @internal */
	private beginStatement(): AST.BeginStmt {
		let mode: 'deferred' | 'immediate' | 'exclusive' | undefined;
		if (this.match(TokenType.DEFERRED)) {
			mode = 'deferred';
		} else if (this.match(TokenType.IMMEDIATE)) {
			mode = 'immediate';
		} else if (this.match(TokenType.EXCLUSIVE)) {
			mode = 'exclusive';
		}

		// Optional TRANSACTION keyword
		this.match(TokenType.TRANSACTION);

		return { type: 'begin', mode };
	}

	/** @internal */
	private commitStatement(): AST.CommitStmt {
		// Optional TRANSACTION keyword
		this.match(TokenType.TRANSACTION);
		return { type: 'commit' };
	}

	/** @internal */
	private rollbackStatement(): AST.RollbackStmt {
		// Optional TRANSACTION keyword
		this.match(TokenType.TRANSACTION);

		// Optional TO [SAVEPOINT] savepoint_name
		let savepoint: string | undefined;
		if (this.match(TokenType.TO)) {
			// Optional SAVEPOINT keyword (need to add to lexer if supporting)
			this.match(TokenType.SAVEPOINT);
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected savepoint name after ROLLBACK TO.");
			}
			savepoint = this.advance().lexeme;
		}
		return { type: 'rollback', savepoint };
	}

	/** @internal */
	private savepointStatement(): AST.SavepointStmt {
		const name = this.consumeIdentifier("Expected savepoint name after SAVEPOINT.");
		return { type: 'savepoint', name };
	}

	/** @internal */
	private releaseStatement(): AST.ReleaseStmt {
		// Optional SAVEPOINT keyword
		this.match(TokenType.SAVEPOINT);
		const name = this.consumeIdentifier("Expected savepoint name after RELEASE [SAVEPOINT].");
		return { type: 'release', savepoint: name };
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
			const direction = this.match(TokenType.ASC) ? 'asc' : this.match(TokenType.DESC) ? 'desc' : undefined; // Optional ASC/DESC
			const onConflict = this.parseConflictClause();
			const autoincrement = this.match(TokenType.AUTOINCREMENT);
			// Direction doesn't really fit in the ColumnConstraint AST for PK, handle if needed
			return { type: 'primaryKey', name, onConflict, autoincrement };
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
			const columns = this.identifierList();
			this.consume(TokenType.RPAREN, "Expected ')' after PRIMARY KEY columns.");
			const onConflict = this.parseConflictClause();
			return { type: 'primaryKey', name, columns, onConflict };
		} else if (this.match(TokenType.UNIQUE)) {
			this.consume(TokenType.LPAREN, "Expected '(' before UNIQUE columns.");
			const columns = this.identifierList();
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
			const columns = this.identifierList();
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

	/** @internal Parses a comma-separated list of identifiers */
	private identifierList(): string[] {
		const identifiers: string[] = [];
		do {
			identifiers.push(this.consumeIdentifier("Expected identifier in list."));
		} while (this.match(TokenType.COMMA));
		return identifiers;
	}
}
