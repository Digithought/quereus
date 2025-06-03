import { createLogger } from '../common/logger.js'; // Import logger
import { Lexer, type Token, TokenType } from './lexer.js';
import * as AST from './ast.js';
import { ConflictResolution } from '../common/constants.js';
import { getLiteralSqlType } from '../common/type-inference.js';
import type { SqlValue } from '../common/types.js';

const log = createLogger('parser:parser'); // Create logger instance
const errorLog = log.extend('error');

export class ParseError extends Error {
	token: Token;

	constructor(token: Token, message: string) {
		super(message);
		this.token = token;
		this.name = 'ParseError';
	}
}

// Helper function to create the location object
function _createLoc(startToken: Token, endToken: Token): AST.AstNode['loc'] {
	return {
		start: {
			line: startToken.startLine,
			column: startToken.startColumn,
			offset: startToken.startOffset,
		},
		end: {
			line: endToken.endLine,
			column: endToken.endColumn,
			offset: endToken.endOffset,
		},
	};
}

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
			throw new ParseError(errorToken, `${errorToken.lexeme} at line ${errorToken.startLine}, column ${errorToken.startColumn}`);
		}

		return this;
	}

	/**
	 * Parse SQL text into an array of ASTs
	 */
	parseAll(sql: string): AST.Statement[] {
		this.initialize(sql);
		const statements: AST.Statement[] = [];

		while (!this.isAtEnd()) {
			try {
				const stmt = this.statement();
				statements.push(stmt as AST.Statement); // Cast needed as statement() returns AstNode

				// Consume optional semicolon at the end of the statement
				this.match(TokenType.SEMICOLON);

			} catch (e) {
				if (e instanceof ParseError) {
					if (!e.message.includes(`at line ${e.token.startLine}`)) {
						const locationInfo = ` at line ${e.token.startLine}, column ${e.token.startColumn}`;
						(e as any).message = e.message + locationInfo;
					}
					throw e;
				}
				errorLog("Unhandled parser error: %O", e);
				throw new Error(`Parser error: ${e instanceof Error ? e.message : e}`);
			}
		}

		// If we consumed all tokens and didn't parse any statements (e.g., empty input or only comments/whitespace),
		// return an empty array instead of throwing an error.
		return statements;
	}

	/**
	 * Parse SQL text into a single AST node.
	 * Use parseAll instead for potentially multi-statement strings.
	 * Throws error if more than one statement is found after the first.
	 */
	parse(sql: string): AST.Statement {
		const statements = this.parseAll(sql);
		if (statements.length === 0) {
			// Handle case of empty input or input with only comments/whitespace
			// Depending on desired behavior, could return null, undefined, or throw.
			// Throwing seems reasonable as prepare/eval expect a statement.
			throw new Error("No SQL statement found to parse.");
		}
		if (statements.length > 1) {
			// Find the token that starts the second statement for better error location
			const secondStatementStartToken = statements[1]?.loc?.start;
			const errToken = this.tokens.find(t => t.startOffset === secondStatementStartToken?.offset) ?? this.peek();
			throw this.error(errToken, "Provided SQL string contains multiple statements. Use exec() for multi-statement execution.");
		}
		return statements[0];
	}

	/**
	 * Attempts to parse a WITH clause if present.
	 * @returns The WithClause AST node or undefined if no WITH clause is found.
	 */
	private tryParseWithClause(): AST.WithClause | undefined {
		if (!this.check(TokenType.WITH)) {
			return undefined;
		}
		const startToken = this.advance(); // Consume WITH

		const recursive = this.match(TokenType.RECURSIVE);

		const ctes: AST.CommonTableExpr[] = [];
		do {
			ctes.push(this.commonTableExpression());
		} while (this.match(TokenType.COMMA));

		const endToken = this.previous(); // Last token of the last CTE

		return { type: 'with', recursive, ctes, loc: _createLoc(startToken, endToken) };
	}

	/**
	 * Parses a single Common Table Expression (CTE).
	 * cte_name [(col1, col2, ...)] AS (query)
	 */
	private commonTableExpression(): AST.CommonTableExpr {
		const startToken = this.peek(); // Peek before consuming name
		const name = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'like'], "Expected CTE name.");
		let endToken = this.previous(); // End token initially is the name

		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					columns.push(this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'like'], "Expected column name in CTE definition."));
				} while (this.match(TokenType.COMMA));
			}
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after CTE column list.");
		}

		this.consume(TokenType.AS, "Expected 'AS' after CTE name.");

		let materializationHint: AST.CommonTableExpr['materializationHint'];
		if (this.matchKeyword('MATERIALIZED')) {
			materializationHint = 'materialized';
		} else if (this.matchKeyword('NOT')) {
			this.consumeKeyword('MATERIALIZED', "Expected 'MATERIALIZED' after 'NOT'.");
			materializationHint = 'not_materialized';
		}

		this.consume(TokenType.LPAREN, "Expected '(' before CTE query.");

		// Parse the CTE query (can be SELECT, VALUES (via SELECT), INSERT, UPDATE, DELETE)
		const queryStartToken = this.peek();
		let query: AST.SelectStmt | AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt;
		if (this.check(TokenType.SELECT)) {
			this.advance(); // Consume SELECT token
			query = this.selectStatement(queryStartToken); // Pass start token
		} else if (this.check(TokenType.INSERT)) {
			this.advance(); // Consume INSERT token
			query = this.insertStatement(queryStartToken);
		} else if (this.check(TokenType.UPDATE)) {
			this.advance(); // Consume UPDATE token
			query = this.updateStatement(queryStartToken);
		} else if (this.check(TokenType.DELETE)) {
			this.advance(); // Consume DELETE token
			query = this.deleteStatement(queryStartToken);
		}
		// TODO: Add support for VALUES directly if needed (though VALUES is usually part of SELECT)
		else {
			throw this.error(this.peek(), "Expected SELECT, INSERT, UPDATE, or DELETE statement for CTE query.");
		}

		endToken = this.consume(TokenType.RPAREN, "Expected ')' after CTE query."); // Capture ')' as end token

		return { type: 'commonTableExpr', name, columns, query, materializationHint, loc: _createLoc(startToken, endToken) };
	}

	/**
	 * Parse a single SQL statement
	 */
	private statement(): AST.AstNode {
		// Check for WITH clause first
		let withClause: AST.WithClause | undefined;
		if (this.check(TokenType.WITH)) {
			withClause = this.tryParseWithClause();
		}

		const startToken = this.peek();
		// --- Check for specific keywords first ---
		const currentKeyword = startToken.lexeme.toUpperCase();
		let stmt: AST.AstNode;

		switch (currentKeyword) {
			case 'SELECT': this.advance(); stmt = this.selectStatement(startToken, withClause); break;
			case 'INSERT': this.advance(); stmt = this.insertStatement(startToken, withClause); break;
			case 'UPDATE': this.advance(); stmt = this.updateStatement(startToken, withClause); break;
			case 'DELETE': this.advance(); stmt = this.deleteStatement(startToken, withClause); break;
			case 'CREATE': this.advance(); stmt = this.createStatement(startToken, withClause); break;
			case 'DROP': this.advance(); stmt = this.dropStatement(startToken, withClause); break;
			case 'ALTER': this.advance(); stmt = this.alterTableStatement(startToken, withClause); break;
			case 'BEGIN': this.advance(); stmt = this.beginStatement(startToken, withClause); break;
			case 'COMMIT': this.advance(); stmt = this.commitStatement(startToken, withClause); break;
			case 'ROLLBACK': this.advance(); stmt = this.rollbackStatement(startToken, withClause); break;
			case 'SAVEPOINT': this.advance(); stmt = this.savepointStatement(startToken, withClause); break;
			case 'RELEASE': this.advance(); stmt = this.releaseStatement(startToken, withClause); break;
			// TODO: Replace pragmas with build-in functions
			case 'PRAGMA': this.advance(); stmt = this.pragmaStatement(startToken, withClause); break;
			// --- Add default case ---
			default:
				// If it wasn't a recognized keyword starting the statement
				throw this.error(startToken, `Expected statement type (SELECT, INSERT, UPDATE, DELETE, CREATE, etc.), got '${startToken.lexeme}'.`);
		}

		// Attach WITH clause if present and supported
		if (withClause && this.statementSupportsWithClause(stmt)) {
			(stmt as any).withClause = withClause;
			if (withClause.loc && stmt.loc) {
				stmt.loc.start = withClause.loc.start;
			}
		} else if (withClause) {
			throw this.error(this.previous(), `WITH clause cannot be used with ${stmt.type} statement.`);
		}

		return stmt;
	}

	/**
	 * Parse an INSERT statement
	 * @returns AST for the INSERT statement
	 */
	insertStatement(startToken: Token, withClause?: AST.WithClause): AST.InsertStmt {
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
		let lastConsumedToken = this.previous(); // After columns or table id

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
				lastConsumedToken = this.previous(); // Update after closing paren of value list
			} while (this.match(TokenType.COMMA));
		} else if (this.check(TokenType.SELECT)) { // If current token is SELECT
			// Handle INSERT ... SELECT
			// Consume the SELECT token, as selectStatement expects to start parsing after it.
			// selectKeywordToken will be the actual 'SELECT' token object, used for location.
			const selectKeywordToken = this.advance(); // Consume 'SELECT'
			// Pass the withClause so the embedded SELECT can (via the planner) resolve CTEs defined for the INSERT.
			select = this.selectStatement(selectKeywordToken, withClause);
			lastConsumedToken = this.previous(); // After SELECT statement is parsed
		} else {
			throw this.error(this.peek(), "Expected VALUES or SELECT after INSERT.");
		}

		return {
			type: 'insert',
			table,
			columns,
			values,
			select,
			loc: _createLoc(startToken, lastConsumedToken),
		};
	}

	/**
	 * Parse a SELECT statement
	 * @param startToken The 'SELECT' token or start token of a sub-query
	 * @param withClause The WITH clause context for CTE access
	 * @param isCompoundSubquery If true, don't parse ORDER BY/LIMIT as they belong to the outer compound
	 * @returns AST for the SELECT statement
	 */
	selectStatement(startToken?: Token, withClause?: AST.WithClause, isCompoundSubquery: boolean = false): AST.SelectStmt {
		const start = startToken ?? this.previous(); // Use provided or the keyword token
		let lastConsumedToken = start; // Initialize lastConsumed

		const distinct = this.matchKeyword('DISTINCT');
		if (distinct) lastConsumedToken = this.previous();
		const all = !distinct && this.matchKeyword('ALL');
		if (all) lastConsumedToken = this.previous();

		// Parse column list
		const columns = this.columnList();
		if (columns.length > 0) lastConsumedToken = this.previous(); // Update after last column element

		// Parse FROM clause if present
		let from: AST.FromClause[] | undefined;
		if (this.match(TokenType.FROM)) {
			from = this.tableSourceList(withClause);
			if (from.length > 0) lastConsumedToken = this.previous(); // After last source/join
		}

		// Parse WHERE clause if present
		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
			lastConsumedToken = this.previous(); // After where expression
		}

		// Parse GROUP BY clause if present
		let groupBy: AST.Expression[] | undefined;
		if (this.match(TokenType.GROUP) && this.consume(TokenType.BY, "Expected 'BY' after 'GROUP'.")) {
			groupBy = [];
			do {
				groupBy.push(this.expression());
			} while (this.match(TokenType.COMMA));
			lastConsumedToken = this.previous(); // After last group by expression
		}

		// Parse HAVING clause if present
		let having: AST.Expression | undefined;
		if (this.match(TokenType.HAVING)) {
			having = this.expression();
			lastConsumedToken = this.previous(); // After having expression
		}

		// Check for compound set operations (UNION / INTERSECT / EXCEPT) BEFORE ORDER BY/LIMIT
		let compound: { op: 'union' | 'unionAll' | 'intersect' | 'except'; select: AST.SelectStmt } | undefined;
		if (this.match(TokenType.UNION, TokenType.INTERSECT, TokenType.EXCEPT)) {
			const tok = this.previous();
			let op: 'union' | 'unionAll' | 'intersect' | 'except';
			if (tok.type === TokenType.UNION) {
				if (this.match(TokenType.ALL)) {
					op = 'unionAll';
				} else {
					op = 'union';
				}
			} else if (tok.type === TokenType.INTERSECT) {
				op = 'intersect';
			} else {
				op = 'except';
			}

			let rightSelect: AST.SelectStmt;

			// Handle parenthesized subquery after set operation
			if (this.match(TokenType.LPAREN)) {
				const selectToken = this.consume(TokenType.SELECT, "Expected 'SELECT' in parenthesized set operation.");
				rightSelect = this.selectStatement(selectToken, withClause, true); // Pass true to indicate compound subquery
				this.consume(TokenType.RPAREN, "Expected ')' after parenthesized set operation.");
			} else {
				// Handle direct SELECT statement
				const selectStartToken = this.peek();
				if (this.match(TokenType.SELECT)) {
					rightSelect = this.selectStatement(selectStartToken, withClause, true); // Pass true to indicate compound subquery
				} else {
					throw this.error(this.peek(), "Expected 'SELECT' or '(' after set operation keyword.");
				}
			}

			lastConsumedToken = this.previous();
			compound = { op, select: rightSelect };
		}

		// Parse ORDER BY clause if present (applies to final result after compound operations)
		// Skip if this is a compound subquery as ORDER BY belongs to the outer compound
		let orderBy: AST.OrderByClause[] | undefined;
		if (!isCompoundSubquery && this.match(TokenType.ORDER) && this.consume(TokenType.BY, "Expected 'BY' after 'ORDER'.")) {
			orderBy = [];
			do {
				const expr = this.expression();
				const direction = this.match(TokenType.DESC) ? 'desc' :
					(this.match(TokenType.ASC) ? 'asc' : 'asc'); // Default to ASC
				orderBy.push({ expr, direction });
			} while (this.match(TokenType.COMMA));
			lastConsumedToken = this.previous(); // After last order by clause
		}

		// Parse LIMIT clause if present (applies to final result after compound operations)
		// Skip if this is a compound subquery as LIMIT belongs to the outer compound
		let limit: AST.Expression | undefined;
		let offset: AST.Expression | undefined;
		if (!isCompoundSubquery && this.match(TokenType.LIMIT)) {
			limit = this.expression();
			lastConsumedToken = this.previous(); // After limit expression

			// LIMIT x OFFSET y syntax
			if (this.match(TokenType.OFFSET)) {
				offset = this.expression();
				lastConsumedToken = this.previous(); // After offset expression
			}
			// LIMIT x, y syntax (x is offset, y is limit)
			else if (this.match(TokenType.COMMA)) {
				offset = limit;
				limit = this.expression();
				lastConsumedToken = this.previous(); // After second limit expression
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
			compound,
			loc: _createLoc(start, lastConsumedToken),
		};
	}

	/**
	 * Parse a comma-separated list of result columns for SELECT
	 */
	private columnList(): AST.ResultColumn[] {
		const columns: AST.ResultColumn[] = [];
		const contextualKeywords = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'];

		do {
			log(`columnList: Loop start. Current token: ${this.peek().lexeme} (${this.peek().type})`); // DEBUG
			// Handle wildcard: * or table.*
			if (this.match(TokenType.ASTERISK)) {
				columns.push({ type: 'all' });
			}
			// Handle table.* syntax
			else if (this.checkIdentifierLike(contextualKeywords) && this.checkNext(1, TokenType.DOT) &&
				this.checkNext(2, TokenType.ASTERISK)) {
				const table = this.consumeIdentifier(contextualKeywords, "Expected table name before '.*'.");
				this.advance(); // consume DOT
				this.advance(); // consume ASTERISK
				columns.push({ type: 'all', table });
			}
			// Handle regular column expression
			else {
				log(`columnList: Parsing expression...`); // DEBUG
				const expr = this.expression();
				log(`columnList: Parsed expression. Current token: ${this.peek().lexeme} (${this.peek().type})`); // DEBUG
				let alias: string | undefined;

				// Handle AS alias or just alias
				if (this.match(TokenType.AS)) {
					if (this.checkIdentifierLike(contextualKeywords) || this.check(TokenType.STRING)) {
						const aliasToken = this.advance();
						alias = aliasToken.lexeme;
						if (aliasToken.type === TokenType.STRING) {
							alias = aliasToken.literal;
						}
					} else {
						throw this.error(this.peek(), "Expected identifier or string after 'AS'.");
					}
				}
				// Implicit alias (no AS keyword)
				else if (this.checkIdentifierLike([]) &&
					!this.checkNext(1, TokenType.LPAREN) &&
					!this.checkNext(1, TokenType.DOT) &&
					!this.checkNext(1, TokenType.COMMA) &&
					!this.isEndOfClause()) {
					const aliasToken = this.advance();
					alias = aliasToken.lexeme;
				}

				columns.push({ type: 'column', expr, alias });
			}
			log(`columnList: Checking for comma. Current token: ${this.peek().lexeme} (${this.peek().type})`); // DEBUG
		} while (this.match(TokenType.COMMA));

		log(`columnList: Loop ended. Current token: ${this.peek().lexeme} (${this.peek().type})`); // DEBUG
		return columns;
	}

	/**
	 * Parse a table identifier (possibly schema-qualified)
	 */
	private tableIdentifier(): AST.IdentifierExpr {
		const startToken = this.peek();
		let schema: string | undefined;
		let name: string;
		let endToken = startToken;
		const contextualKeywords = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'];

		// Check for schema.table pattern
		if (this.checkIdentifierLike(contextualKeywords) && this.checkNext(1, TokenType.DOT)) {
			schema = this.consumeIdentifier(contextualKeywords, "Expected schema name.");
			this.advance(); // Consume DOT
			name = this.consumeIdentifier(contextualKeywords, "Expected table name after schema.");
			endToken = this.previous();
		} else if (this.checkIdentifierLike(contextualKeywords)) {
			name = this.consumeIdentifier(contextualKeywords, "Expected table name.");
			endToken = this.previous();
		} else {
			throw this.error(this.peek(), "Expected table name.");
		}

		return {
			type: 'identifier',
			name,
			schema,
			loc: _createLoc(startToken, endToken),
		};
	}

	/**
	 * Parse a comma-separated list of table sources (FROM clause)
	 */
	private tableSourceList(withClause?: AST.WithClause): AST.FromClause[] {
		const sources: AST.FromClause[] = [];

		do {
			// Get the base table source
			let source: AST.FromClause = this.tableSource(withClause);

			// Look for JOINs
			while (this.isJoinToken()) {
				source = this.joinClause(source, withClause);
			}

			sources.push(source);
		} while (this.match(TokenType.COMMA));

		return sources;
	}

	/**
	 * Parse a single table source, which can now be a table name, table-valued function call, or subquery
	 */
	private tableSource(withClause?: AST.WithClause): AST.FromClause {
		const startToken = this.peek();
		const contextualKeywords = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'];

		// Check for subquery: ( SELECT ...
		if (this.check(TokenType.LPAREN)) {
			// Look ahead to see if this is a subquery
			const lookahead = this.current + 1;
			if (lookahead < this.tokens.length &&
				this.tokens[lookahead].type === TokenType.SELECT) {
				return this.subquerySource(startToken, withClause);
			}
		}

		// Check for function call syntax: IDENTIFIER (
		if (this.checkIdentifierLike(contextualKeywords) && this.checkNext(1, TokenType.LPAREN)) {
			return this.functionSource(startToken);
		}
		// Otherwise, assume it's a standard table source
		else {
			return this.standardTableSource(startToken);
		}
	}

	/** Parses a subquery source: (SELECT ...) AS alias */
	private subquerySource(startToken: Token, withClause?: AST.WithClause): AST.SubquerySource {
		this.consume(TokenType.LPAREN, "Expected '(' before subquery.");

		// Consume the SELECT token and pass it as startToken to selectStatement
		const selectToken = this.consume(TokenType.SELECT, "Expected 'SELECT' in subquery.");
		const subquery = this.selectStatement(selectToken, withClause);

		this.consume(TokenType.RPAREN, "Expected ')' after subquery.");

		// Parse optional alias for subquery
		let alias: string;
		if (this.match(TokenType.AS)) {
			if (!this.checkIdentifierLike([])) {
				throw this.error(this.peek(), "Expected alias after 'AS'.");
			}
			const aliasToken = this.advance();
			alias = aliasToken.lexeme;
		} else if (this.checkIdentifierLike([]) &&
			!this.checkNext(1, TokenType.DOT) &&
			!this.checkNext(1, TokenType.COMMA) &&
			!this.isJoinToken() &&
			!this.isEndOfClause()) {
			const aliasToken = this.advance();
			alias = aliasToken.lexeme;
		} else {
			// Generate a default alias if none provided
			alias = `subquery_${startToken.startOffset}`;
		}

		const endToken = this.previous();
		return {
			type: 'subquerySource',
			subquery,
			alias,
			loc: _createLoc(startToken, endToken),
		};
	}

	/** Parses a standard table source (schema.table or table) */
	private standardTableSource(startToken: Token): AST.TableSource {
		const contextualKeywords = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'];

		// Parse table name (potentially schema-qualified)
		const table = this.tableIdentifier();
		let endToken = this.previous(); // Initialize endToken after parsing table identifier

		// Parse optional alias
		let alias: string | undefined;
		if (this.match(TokenType.AS)) {
			if (!this.checkIdentifierLike(contextualKeywords)) {
				throw this.error(this.peek(), "Expected alias after 'AS'.");
			}
			const aliasToken = this.advance();
			alias = aliasToken.lexeme;
			endToken = aliasToken;
		} else if (this.checkIdentifierLike([]) &&
			!this.checkNext(1, TokenType.DOT) &&
			!this.checkNext(1, TokenType.COMMA) &&
			!this.isJoinToken() &&
			!this.isEndOfClause()) {
			const aliasToken = this.advance();
			alias = aliasToken.lexeme;
			endToken = aliasToken;
		}

		return {
			type: 'table',
			table,
			alias,
			loc: _createLoc(startToken, endToken),
		};
	}

	/** Parses a table-valued function source: name(arg1, ...) [AS alias] */
	private functionSource(startToken: Token): AST.FunctionSource {
		const contextualKeywords = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'];

		const name = this.tableIdentifier(); // name has its own loc
		let endToken = this.previous(); // Initialize endToken after parsing function identifier

		this.consume(TokenType.LPAREN, "Expected '(' after table function name.");

		const args: AST.Expression[] = [];
		if (!this.check(TokenType.RPAREN)) {
			// Handle DISTINCT inside function calls like COUNT(DISTINCT col)
			const distinct = this.matchKeyword('DISTINCT');
			// Handle * argument AFTER checking for distinct
			if (this.match(TokenType.ASTERISK)) {
				// Do not add '*' as an argument to the list for aggregates like COUNT(*)
				if (args.length > 0 || distinct) {
					// '*' is only valid as the *only* argument, potentially after DISTINCT
					// e.g. COUNT(*), COUNT(DISTINCT *) - though DISTINCT * might not be standard SQL?
					// For now, disallow '*' if other args exist.
					throw this.error(this.previous(), "'*' cannot be used with other arguments in function call.");
				}
				// If we parsed '*', the args list remains empty.
			} else {
				// Parse regular arguments if '*' wasn't found
				do {
					args.push(this.expression());
				} while (this.match(TokenType.COMMA));
			}
		}

		endToken = this.consume(TokenType.RPAREN, "Expected ')' after table function arguments.");

		// Parse optional alias (same logic as for standard tables)
		let alias: string | undefined;
		if (this.match(TokenType.AS)) {
			if (!this.checkIdentifierLike(contextualKeywords)) {
				throw this.error(this.peek(), "Expected alias after 'AS'.");
			}
			const aliasToken = this.advance();
			alias = aliasToken.lexeme;
			endToken = aliasToken;
		} else if (this.checkIdentifierLike([]) &&
			!this.checkNext(1, TokenType.DOT) &&
			!this.checkNext(1, TokenType.COMMA) &&
			!this.isJoinToken() &&
			!this.isEndOfClause()) {
			const aliasToken = this.advance();
			alias = aliasToken.lexeme;
			endToken = aliasToken;
		}

		return {
			type: 'functionSource',
			name,
			args,
			alias,
			loc: _createLoc(startToken, endToken),
		};
	}

	/**
	 * Parse a JOIN clause
	 */
	private joinClause(left: AST.FromClause, withClause?: AST.WithClause): AST.JoinClause {
		const joinStartToken = this.peek(); // Capture token before parsing JOIN type

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
		const right = this.tableSource(withClause);

		// Parse join condition
		let condition: AST.Expression | undefined;
		let columns: string[] | undefined;
		let endToken = this.previous(); // End token is end of right source initially

		if (this.match(TokenType.ON)) {
			condition = this.expression();
			endToken = this.previous(); // End token is end of ON expression
		} else if (this.match(TokenType.USING)) {
			this.consume(TokenType.LPAREN, "Expected '(' after 'USING'.");
			columns = [];
			const contextualKeywords = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'];

			do {
				columns.push(this.consumeIdentifier(contextualKeywords, "Expected column name."));
			} while (this.match(TokenType.COMMA));

			endToken = this.consume(TokenType.RPAREN, "Expected ')' after columns.");
		} else if (joinType !== 'cross') {
			throw this.error(this.peek(), "Expected 'ON' or 'USING' after JOIN.");
		}

		return {
			type: 'join',
			joinType,
			left,
			right,
			condition,
			columns,
			loc: _createLoc(joinStartToken, endToken),
		};
	}

	/**
	 * Parse an expression
	 */
	private expression(): AST.Expression {
		return this.logicalXorOr();
	}

	/**
	 * Parse logical OR and XOR expressions (lowest precedence)
	 */
	private logicalXorOr(): AST.Expression {
		let expr = this.logicalAnd();
		const startToken = expr.loc ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek(); // Get start token of left expr

		while (this.match(TokenType.OR, TokenType.XOR)) { // Added XOR
			const operator = this.previous().type === TokenType.XOR ? 'XOR' : 'OR'; // Determine operator
			const right = this.logicalAnd();
			const endToken = this.previous(); // End token is end of right expr
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right,
				loc: _createLoc(startToken, endToken),
			};
		}

		return expr;
	}

	/**
	 * Parse logical AND expression
	 */
	private logicalAnd(): AST.Expression {
		let expr = this.isNull();
		const startToken = expr.loc ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek(); // Get start token of left expr

		while (this.match(TokenType.AND)) {
			const operator = 'AND';
			const right = this.isNull();
			const endToken = this.previous(); // End token is end of right expr
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right,
				loc: _createLoc(startToken, endToken),
			};
		}

		return expr;
	}

	/**
	 * Parse IS NULL / IS NOT NULL expressions
	 */
	private isNull(): AST.Expression {
		let expr = this.equality();
		const startToken = expr.loc ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek(); // Get start token of left expr

		if (this.match(TokenType.IS)) {
			let isNot = false;
			if (this.match(TokenType.NOT)) {
				isNot = true;
			}
			if (this.match(TokenType.NULL)) {
				const endToken = this.previous(); // End token is NULL
				const operator = isNot ? 'IS NOT NULL' : 'IS NULL';
				// Represent IS NULL / IS NOT NULL as UnaryExpr for simplicity
				return { type: 'unary', operator, expr, loc: _createLoc(startToken, endToken) };
			}
			// If it was IS or IS NOT but not followed by NULL, maybe it's IS TRUE/FALSE/DISTINCT FROM?
			// For now, assume standard comparison if NULL doesn't follow IS [NOT]
			// We need to "unread" the IS and optional NOT token if we didn't match NULL.
			// Backtrack current position.
			if (isNot) this.current--; // Backtrack NOT
			this.current--; // Backtrack IS
		}

		return expr;
	}

	/**
	 * Parse equality expression
	 */
	private equality(): AST.Expression {
		let expr = this.comparison();
		const startToken = expr.loc ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek(); // Get start token of left expr

		while (this.match(TokenType.EQUAL, TokenType.EQUAL_EQUAL, TokenType.NOT_EQUAL)) {
			let operator: string;
			switch (this.previous().type) {
				case TokenType.NOT_EQUAL: operator = '!='; break;
				case TokenType.EQUAL_EQUAL: operator = '=='; break;
				default: operator = '='; break;
			}
			const right = this.comparison();
			const endToken = this.previous(); // End token is end of right expr
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right,
				loc: _createLoc(startToken, endToken),
			};
		}

		return expr;
	}

	/**
	 * Parse comparison expression
	 */
	private comparison(): AST.Expression {
		let expr = this.term();
		const startToken = expr.loc ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek(); // Get start token of left expr

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
			const endToken = this.previous(); // End token is end of right expr
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right,
				loc: _createLoc(startToken, endToken),
			};
		}

		return expr;
	}

	/**
	 * Parse addition and subtraction
	 */
	private term(): AST.Expression {
		let expr = this.factor();
		const startToken = expr.loc ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek(); // Get start token of left expr

		while (this.match(TokenType.PLUS, TokenType.MINUS)) {
			const operator = this.previous().type === TokenType.PLUS ? '+' : '-';
			const right = this.factor();
			const endToken = this.previous(); // End token is end of right expr
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right,
				loc: _createLoc(startToken, endToken),
			};
		}

		return expr;
	}

	/**
	 * Parse multiplication and division
	 */
	private factor(): AST.Expression {
		// First, handle unary operators
		if (this.match(TokenType.MINUS, TokenType.PLUS, TokenType.TILDE, TokenType.NOT)) { // Added NOT
			const operatorToken = this.previous();
			const operatorStartToken = operatorToken; // Start token is the operator itself
			const operator = operatorToken.lexeme;
			// Unary operator applies to the result of the *next* precedence level (concatenation)
			const right = this.concatenation(); // Should call concatenation (higher precedence than factor)
			const endToken = this.previous(); // End token is end of the operand
			return { type: 'unary', operator, expr: right, loc: _createLoc(operatorStartToken, endToken) };
		}

		let expr = this.concatenation(); // Factor operands have higher precedence (concatenation)
		const startToken = expr.loc ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek(); // Get start token of left expr

		while (this.match(TokenType.ASTERISK, TokenType.SLASH, TokenType.PERCENT)) {
			const operatorToken = this.previous();
			const operator = operatorToken.lexeme;
			const right = this.concatenation(); // Factor operands have higher precedence (concatenation)
			const endToken = this.previous(); // End token is end of right expr
			expr = { type: 'binary', operator, left: expr, right, loc: _createLoc(startToken, endToken) };
		}

		return expr;
	}

	/**
	 * Parse concatenation expression (||)
	 */
	private concatenation(): AST.Expression {
		let expr = this.collateExpression(); // Concatenation operands have higher precedence (collate)
		const startToken = expr.loc ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek(); // Get start token of left expr

		while (this.match(TokenType.PIPE_PIPE)) {
			const operator = '||';
			const right = this.collateExpression(); // Concatenation operands have higher precedence (collate)
			const endToken = this.previous(); // End token is end of right expr
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right,
				loc: _createLoc(startToken, endToken),
			};
		}

		return expr;
	}

	/**
	 * Parse COLLATE expression
	 */
	private collateExpression(): AST.Expression {
		const expr = this.primary(); // Parse primary expression first

		if (this.matchKeyword('COLLATE')) {
			const collationToken = this.consume(TokenType.IDENTIFIER, "Expected collation name after COLLATE.");
			const collation = collationToken.lexeme;
			// Use the start of the original expression and end of collation name for location
			const startLocToken = expr.loc?.start ? this.tokens.find(t => t.startOffset === expr.loc!.start.offset) ?? this.peek() : this.peek();
			return { type: 'collate', expr, collation, loc: _createLoc(startLocToken, collationToken) };
		}

		return expr;
	}

	/**
	 * Parse primary expressions (literals, identifiers, etc.)
	 */
	private primary(): AST.Expression {
		const startToken = this.peek();

		// Case expression
		if (this.matchKeyword('CASE')) {
			return this.parseCaseExpression(startToken);
		}

		// CAST expression: CAST(expr AS type)
		if (this.peekKeyword('CAST') && this.checkNext(1, TokenType.LPAREN)) {
			const castToken = this.advance(); // Consume CAST
			this.consume(TokenType.LPAREN, "Expected '(' after CAST.");
			const expr = this.expression();
			this.consumeKeyword('AS', "Expected 'AS' in CAST expression.");
			// Allow type names that might be keywords (e.g., TEXT, INTEGER, REAL, BLOB)
			// or multi-word type names if supported (e.g., "VARCHAR(255)") - for now, simple identifier
			if (!this.check(TokenType.IDENTIFIER) &&
				!this.isTypeNameKeyword(this.peek().lexeme.toUpperCase())) {
				throw this.error(this.peek(), "Expected type name after 'AS' in CAST expression.");
			}
			const typeToken = this.advance(); // Consume type name
			const targetType = typeToken.lexeme;
			const endToken = this.consume(TokenType.RPAREN, "Expected ')' after CAST expression type.");
			return { type: 'cast', expr, targetType, loc: _createLoc(castToken, endToken) };
		}

		// Literals
		if (this.match(TokenType.INTEGER, TokenType.FLOAT, TokenType.STRING, TokenType.NULL, TokenType.BLOB)) {
			const token = this.previous();
			let value: any;
			let lexeme: string | undefined = undefined;

			if (token.type === TokenType.NULL) {
				value = null;
				lexeme = token.lexeme; // Store original case (NULL vs null)
			} else if (token.type === TokenType.FLOAT) {
				// For FLOAT, parse the literal (which is the original string)
				value = parseFloat(token.literal as string);
				lexeme = token.literal as string; // Store original string as lexeme
			} else if (token.type === TokenType.INTEGER) {
				value = token.literal; // Already number or BigInt
				if (token.lexeme !== String(value)) { // Store lexeme only if different
					lexeme = token.lexeme;
				}
			} else {
				value = token.literal; // STRING, BLOB
			}

			const node: AST.LiteralExpr = { type: 'literal', value, loc: _createLoc(startToken, token) };
			if (lexeme !== undefined) {
				node.lexeme = lexeme;
			}
			return node;
		}

		// Parameter expressions (?, :name, $name)
		if (this.match(TokenType.QUESTION)) {
			const token = this.previous();
			return { type: 'parameter', index: this.parameterPosition++, loc: _createLoc(startToken, token) };
		}

		if (this.match(TokenType.COLON, TokenType.DOLLAR)) {
			// Named parameter (can be identifier like :name or integer like :1)
			if (!this.check(TokenType.IDENTIFIER) && !this.check(TokenType.INTEGER)) {
				throw this.error(this.peek(), "Expected identifier or number after parameter prefix.");
			}
			const nameToken = this.advance();
			return { type: 'parameter', name: nameToken.lexeme, loc: _createLoc(startToken, nameToken) };
		}

		// Function call (with optional window function support)
		if (this.checkIdentifierLike(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like']) && this.checkNext(1, TokenType.LPAREN)) {
			const name = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected function name.");

			this.consume(TokenType.LPAREN, "Expected '(' after function name.");

			const args: AST.Expression[] = [];
			let distinct = false;
			if (!this.check(TokenType.RPAREN)) {
				// Handle DISTINCT inside function calls like COUNT(DISTINCT col)
				distinct = this.matchKeyword('DISTINCT');
				// Handle * argument AFTER checking for distinct
				if (this.match(TokenType.ASTERISK)) {
					// Do not add '*' as an argument to the list for aggregates like COUNT(*)
					if (args.length > 0 || distinct) {
						// '*' is only valid as the *only* argument, potentially after DISTINCT
						// e.g. COUNT(*), COUNT(DISTINCT *) - though DISTINCT * might not be standard SQL?
						// For now, disallow '*' if other args exist.
						throw this.error(this.previous(), "'*' cannot be used with other arguments in function call.");
					}
					// If we parsed '*', the args list remains empty.
				} else {
					// Parse regular arguments if '*' wasn't found
					do {
						args.push(this.expression());
					} while (this.match(TokenType.COMMA));
				}
			}

			const endToken = this.consume(TokenType.RPAREN, "Expected ')' after function arguments.");

			const funcExpr: AST.FunctionExpr = {
				type: 'function',
				name,
				args,
				loc: _createLoc(startToken, endToken)
			};

			// Add distinct field if it was parsed
			if (distinct) {
				funcExpr.distinct = true;
			}

			// Check for OVER clause (window function)
			if (this.matchKeyword('OVER')) {
				const window = this.parseWindowSpecification();
				const overEndToken = this.previous();
				return {
					type: 'windowFunction',
					function: funcExpr,
					window,
					loc: _createLoc(startToken, overEndToken)
				};
			}

			return funcExpr;
		}

		// Column/identifier expressions
		const contextualKeywords = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'];
		if (this.checkIdentifierLike(contextualKeywords)) {
			// Schema.table.column
			if (this.checkNext(1, TokenType.DOT) && this.checkIdentifierLikeAt(2, contextualKeywords) &&
				this.checkNext(3, TokenType.DOT) && this.checkIdentifierLikeAt(4, contextualKeywords)) {
				const schema = this.consumeIdentifier(contextualKeywords, "Expected schema name.");
				this.advance(); // Consume DOT
				const table = this.consumeIdentifier(contextualKeywords, "Expected table name.");
				this.advance(); // Consume DOT
				const name = this.consumeIdentifier(contextualKeywords, "Expected column name.");
				const nameToken = this.previous();

				return {
					type: 'column',
					name,
					table,
					schema,
					loc: _createLoc(startToken, nameToken),
				};
			}
			// table.column
			else if (this.checkNext(1, TokenType.DOT) && this.checkIdentifierLikeAt(2, contextualKeywords)) {
				const table = this.consumeIdentifier(contextualKeywords, "Expected table name.");
				this.advance(); // Consume DOT
				const name = this.consumeIdentifier(contextualKeywords, "Expected column name.");
				const nameToken = this.previous();

				return {
					type: 'column',
					name,
					table,
					loc: _createLoc(startToken, nameToken),
				};
			}
			// just column
			else {
				const name = this.consumeIdentifier(contextualKeywords, "Expected column name.");
				const nameToken = this.previous();

				return {
					type: 'column',
					name,
					loc: _createLoc(startToken, nameToken),
				};
			}
		}

		// Parenthesized expression or scalar subquery
		if (this.match(TokenType.LPAREN)) {
			// Look ahead to see if this is a scalar subquery (SELECT ...)
			if (this.check(TokenType.SELECT)) {
				const selectToken = this.consume(TokenType.SELECT, "Expected 'SELECT' in subquery.");
				const subquery = this.selectStatement(selectToken);
				this.consume(TokenType.RPAREN, "Expected ')' after subquery.");
				return {
					type: 'subquery',
					query: subquery,
					loc: _createLoc(startToken, this.previous())
				};
			} else {
				// Regular parenthesized expression
				const expr = this.expression();
				this.consume(TokenType.RPAREN, "Expected ')' after expression.");
				return expr;
			}
		}

		throw this.error(this.peek(), "Expected expression.");
	}

	/**
	 * Parses a window specification: (PARTITION BY ... ORDER BY ... [frame])
	 */
	private parseWindowSpecification(): AST.WindowDefinition {
		if (this.match(TokenType.LPAREN)) {
			let partitionBy: AST.Expression[] | undefined;
			let orderBy: AST.OrderByClause[] | undefined;
			let frame: AST.WindowFrame | undefined;

			if (this.matchKeyword('PARTITION')) {
				this.consumeKeyword('BY', "Expected 'BY' after 'PARTITION'.");
				partitionBy = [];
				do {
					partitionBy.push(this.expression());
				} while (this.match(TokenType.COMMA));
			}

			if (this.matchKeyword('ORDER')) {
				this.consumeKeyword('BY', "Expected 'BY' after 'ORDER'.");
				orderBy = [];
				do {
					const expr = this.expression();
					const direction = this.match(TokenType.DESC) ? 'desc' : (this.match(TokenType.ASC) ? 'asc' : 'asc');
					orderBy.push({ expr, direction });
				} while (this.match(TokenType.COMMA));
			}

			// Frame clause (ROWS|RANGE ...)
			if (this.matchKeyword('ROWS') || this.matchKeyword('RANGE')) {
				const frameType = this.previous().lexeme.toLowerCase() as 'rows' | 'range';
				const start = this.parseWindowFrameBound();
				let end: AST.WindowFrameBound | null = null;
				if (this.matchKeyword('AND')) {
					end = this.parseWindowFrameBound();
				}
				frame = { type: frameType, start, end };
			}

			this.consume(TokenType.RPAREN, "Expected ')' after window specification.");
			return { type: 'windowDefinition', partitionBy, orderBy, frame };
		} else {
			// Window name (not implemented)
			throw this.error(this.peek(), 'Window name references are not yet supported. Use explicit window specs.');
		}
	}

	/**
	 * Parses a window frame bound (UNBOUNDED PRECEDING, CURRENT ROW, n PRECEDING/FOLLOWING)
	 */
	private parseWindowFrameBound(): AST.WindowFrameBound {
		if (this.matchKeyword('UNBOUNDED')) {
			if (this.matchKeyword('PRECEDING')) {
				return { type: 'unboundedPreceding' };
			} else if (this.matchKeyword('FOLLOWING')) {
				return { type: 'unboundedFollowing' };
			} else {
				throw this.error(this.peek(), "Expected PRECEDING or FOLLOWING after UNBOUNDED.");
			}
		} else if (this.matchKeyword('CURRENT')) {
			this.consumeKeyword('ROW', "Expected 'ROW' after 'CURRENT'.");
			return { type: 'currentRow' };
		} else {
			const value = this.expression();
			if (this.matchKeyword('PRECEDING')) {
				return { type: 'preceding', value };
			} else if (this.matchKeyword('FOLLOWING')) {
				return { type: 'following', value };
			} else {
				throw this.error(this.peek(), "Expected PRECEDING or FOLLOWING after frame value.");
			}
		}
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

	private consume(type: TokenType, message: string): Token {
		if (this.check(type)) {
			return this.advance();
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
		const locationInfo = ` at line ${token.startLine}, column ${token.startColumn}`;
		return new ParseError(token, message + locationInfo);
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
	private updateStatement(startToken: Token, withClause?: AST.WithClause): AST.UpdateStmt {
		const table = this.tableIdentifier();
		this.consume(TokenType.SET, "Expected 'SET' after table name in UPDATE.");
		const assignments: { column: string; value: AST.Expression }[] = [];
		do {
			const column = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected column name in SET clause.");
			this.consume(TokenType.EQUAL, "Expected '=' after column name in SET clause.");
			const value = this.expression();
			assignments.push({ column, value });
		} while (this.match(TokenType.COMMA));
		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}
		const endToken = this.previous();
		return { type: 'update', table, assignments, where, loc: _createLoc(startToken, endToken) };
	}

	/** @internal */
	private deleteStatement(startToken: Token, withClause?: AST.WithClause): AST.DeleteStmt {
		this.matchKeyword('FROM');
		const table = this.tableIdentifier();
		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}
		const endToken = this.previous();
		return { type: 'delete', table, where, loc: _createLoc(startToken, endToken) };
	}

	/** @internal */
	private createStatement(startToken: Token, withClause?: AST.WithClause): AST.CreateTableStmt | AST.CreateIndexStmt | AST.CreateViewStmt {
		if (this.peekKeyword('TABLE')) {
			this.consumeKeyword('TABLE', "Expected 'TABLE' after CREATE.");
			return this.createTableStatement(startToken, withClause);
		} else if (this.peekKeyword('INDEX')) {
			this.consumeKeyword('INDEX', "Expected 'INDEX' after CREATE.");
			return this.createIndexStatement(startToken, false, withClause);
		} else if (this.peekKeyword('VIEW')) {
			this.consumeKeyword('VIEW', "Expected 'VIEW' after CREATE.");
			return this.createViewStatement(startToken, withClause);
		} else if (this.peekKeyword('UNIQUE')) {
			this.consumeKeyword('UNIQUE', "Expected 'UNIQUE' after CREATE.");
			this.consumeKeyword('INDEX', "Expected 'INDEX' after CREATE UNIQUE.");
			return this.createIndexStatement(startToken, true, withClause);
		}
		throw this.error(this.peek(), "Expected TABLE, [UNIQUE] INDEX, VIEW, or VIRTUAL after CREATE.");
	}

	/**
	 * Parse CREATE TABLE statement
	 * @returns AST for CREATE TABLE
	 */
	private createTableStatement(startToken: Token, withClause?: AST.WithClause): AST.CreateTableStmt {
		let isTemporary = false;
		if (this.peekKeyword('TEMP') || this.peekKeyword('TEMPORARY')) {
			isTemporary = true;
			this.advance();
		}

		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const table = this.tableIdentifier();

		let moduleName: string | undefined;
		let moduleArgs: Record<string, SqlValue> = {};
		if (this.matchKeyword('USING')) {
			moduleName = this.consumeIdentifier("Expected module name after 'USING'.");
			if (this.matchKeyword('(')) {
				while (!this.match(TokenType.RPAREN)) {
					const nameValue = this.nameValueItem("module argument");
					moduleArgs[nameValue.name] = nameValue.value.type === 'literal' ? nameValue.value.value : nameValue.value.name;
					if (!this.match(TokenType.COMMA) || this.check(TokenType.RPAREN)) {
						throw this.error(this.peek(), "Expected ',' or ')' after module argument.");
					}
				}
			}
		}

		const columns: AST.ColumnDef[] = [];
		const constraints: AST.TableConstraint[] = [];

		if (this.check(TokenType.LPAREN)) {
			this.consume(TokenType.LPAREN, "Expected '(' to start table definition.");
			do {
				if (this.peekKeyword('PRIMARY') || this.peekKeyword('UNIQUE') || this.peekKeyword('CHECK') || this.peekKeyword('FOREIGN') || this.peekKeyword('CONSTRAINT')) {
					constraints.push(this.tableConstraint());
				} else {
					columns.push(this.columnDefinition());
				}
			} while (this.match(TokenType.COMMA));

			this.consume(TokenType.RPAREN, "Expected ')' after table definition.");

		} else if (this.matchKeyword('AS')) {
			throw new Error('CREATE TABLE AS SELECT is not supported.');
		} else {
			throw this.error(this.peek(), "Expected '(' or 'AS' after table name.");
		}

		return {
			type: 'createTable',
			table,
			ifNotExists,
			columns,
			constraints,
			isTemporary,
			moduleName,
			moduleArgs,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse CREATE INDEX statement
	 * @param isUnique Flag indicating if UNIQUE keyword was already parsed
	 * @returns AST for CREATE INDEX
	 */
	private createIndexStatement(startToken: Token, isUnique = false, withClause?: AST.WithClause): AST.CreateIndexStmt {
		if (!isUnique && this.peekKeyword('UNIQUE')) {
			isUnique = true;
			this.advance();
		}

		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const index = this.tableIdentifier();

		this.consumeKeyword('ON', "Expected 'ON' after index name.");

		const table = this.tableIdentifier();

		this.consume(TokenType.LPAREN, "Expected '(' before indexed columns.");
		const columns = this.indexedColumnList();
		this.consume(TokenType.RPAREN, "Expected ')' after indexed columns.");

		let where: AST.Expression | undefined;
		if (this.matchKeyword('WHERE')) {
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
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse CREATE VIEW statement
	 * @returns AST for CREATE VIEW
	 */
	private createViewStatement(startToken: Token, withClause?: AST.WithClause): AST.CreateViewStmt {
		let isTemporary = false;
		if (this.peekKeyword('TEMP') || this.peekKeyword('TEMPORARY')) {
			isTemporary = true;
			this.advance();
		}

		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const view = this.tableIdentifier();

		let columns: string[] | undefined;
		if (this.check(TokenType.LPAREN)) {
			this.consume(TokenType.LPAREN, "Expected '(' to start view column list.");
			columns = [];
			const contextualKeywords = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'];
			if (!this.check(TokenType.RPAREN)) {
				do {
					columns.push(this.consumeIdentifier(contextualKeywords, "Expected column name in view column list."));
				} while (this.match(TokenType.COMMA));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after view column list.");
		}

		this.consumeKeyword('AS', "Expected 'AS' before SELECT statement for CREATE VIEW.");

		const selectStartToken = this.consume(TokenType.SELECT, "Expected 'SELECT' after 'AS' in CREATE VIEW.");
		const select = this.selectStatement(selectStartToken, withClause);

		return {
			type: 'createView',
			view,
			ifNotExists,
			columns,
			select,
			isTemporary,
				loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse DROP statement
	 * @returns AST for DROP statement
	 */
	private dropStatement(startToken: Token, withClause?: AST.WithClause): AST.DropStmt {
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
		} else {
			throw this.error(this.peek(), "Expected TABLE, VIEW, or INDEX after DROP.");
		}

		let ifExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF'.");
			ifExists = true;
		}

		const name = this.tableIdentifier();

		return {
			type: 'drop',
			objectType,
			name,
			ifExists,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse ALTER TABLE statement
	 * @returns AST for ALTER TABLE statement
	 */
	private alterTableStatement(startToken: Token, withClause?: AST.WithClause): AST.AlterTableStmt {
		this.consumeKeyword('TABLE', "Expected 'TABLE' after ALTER.");

		const table = this.tableIdentifier();

		let action: AST.AlterTableAction;

		if (this.peekKeyword('RENAME')) {
			this.consumeKeyword('RENAME', "Expected RENAME.");
			if (this.matchKeyword('COLUMN')) {
				const oldName = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected old column name after RENAME COLUMN.");
				this.consumeKeyword('TO', "Expected 'TO' after old column name.");
				const newName = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected new column name after TO.");
				action = { type: 'renameColumn', oldName, newName };
			} else {
				this.consumeKeyword('TO', "Expected 'TO' after RENAME.");
				const newName = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected new table name after RENAME TO.");
				action = { type: 'renameTable', newName };
			}
		} else if (this.peekKeyword('ADD')) {
			this.consumeKeyword('ADD', "Expected ADD.");
			this.matchKeyword('COLUMN');
			const column = this.columnDefinition();
			action = { type: 'addColumn', column };
		} else if (this.peekKeyword('DROP')) {
			this.consumeKeyword('DROP', "Expected DROP.");
			this.matchKeyword('COLUMN');
			const name = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected column name after DROP COLUMN.");
			action = { type: 'dropColumn', name };
		} else {
			throw this.error(this.peek(), "Expected RENAME, ADD, or DROP after table name in ALTER TABLE.");
		}

		return {
			type: 'alterTable',
			table,
			action,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse BEGIN statement
	 * @returns AST for BEGIN statement
	 */
	private beginStatement(startToken: Token, withClause?: AST.WithClause): AST.BeginStmt {
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

		this.matchKeyword('TRANSACTION');

		return { type: 'begin', mode, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse COMMIT statement
	 * @returns AST for COMMIT statement
	 */
	private commitStatement(startToken: Token, withClause?: AST.WithClause): AST.CommitStmt {
		this.matchKeyword('TRANSACTION');
		return { type: 'commit', loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse ROLLBACK statement
	 * @returns AST for ROLLBACK statement
	 */
	private rollbackStatement(startToken: Token, withClause?: AST.WithClause): AST.RollbackStmt {
		this.matchKeyword('TRANSACTION');

		let savepoint: string | undefined;
		if (this.matchKeyword('TO')) {
			this.matchKeyword('SAVEPOINT');
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected savepoint name after ROLLBACK TO.");
			}
			savepoint = this.advance().lexeme;
		}
		return { type: 'rollback', savepoint, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse SAVEPOINT statement
	 * @returns AST for SAVEPOINT statement
	 */
	private savepointStatement(startToken: Token, withClause?: AST.WithClause): AST.SavepointStmt {
		const name = this.consumeIdentifier("Expected savepoint name after SAVEPOINT.");
		return { type: 'savepoint', name, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse RELEASE statement
	 * @returns AST for RELEASE statement
	 */
	private releaseStatement(startToken: Token, withClause?: AST.WithClause): AST.ReleaseStmt {
		this.matchKeyword('SAVEPOINT');
		const name = this.consumeIdentifier("Expected savepoint name after RELEASE [SAVEPOINT].");
		return { type: 'release', savepoint: name, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse PRAGMA statement
	 * @returns AST for PRAGMA statement
	 */
	private pragmaStatement(startToken: Token, withClause?: AST.WithClause): AST.PragmaStmt {
		const nameValue = this.nameValueItem("pragma");
		return { type: 'pragma', ...nameValue, loc: _createLoc(startToken, this.previous()) };
	}

	private nameValueItem(context: string): { name: string, value: AST.IdentifierExpr | AST.LiteralExpr } {
		const name = this.consumeIdentifier(`Expected ${context} name.`);

		let value: AST.LiteralExpr | AST.IdentifierExpr | undefined;
		if (this.match(TokenType.EQUAL)) {
			if (this.check(TokenType.IDENTIFIER)) {
				value = { type: 'identifier', name: this.advance().lexeme };
			} else if (this.match(TokenType.STRING, TokenType.INTEGER, TokenType.FLOAT, TokenType.NULL)) {
				const token = this.previous();
				value = { type: 'literal', value: token.type === TokenType.NULL ? null : token.literal };
			} else if (this.match(TokenType.MINUS)) {
				if (this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT)) {
					const token = this.advance();
					value = { type: 'literal', value: -token.literal };
				} else {
					throw this.error(this.peek(), "Expected number after '-'.");
				}
			} else {
				throw this.error(this.peek(), `Expected ${context} value (identifier, string, number, or NULL).`);
			}
		} else {
			throw this.error(this.peek(), `Expected '=' after ${context} name.`);
		}

		return { name: name.toLowerCase(), value };
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
		const expr = this.expression();

		let name: string | undefined;
		if (expr.type === 'column' && !expr.table && !expr.schema) {
			name = expr.name;
		}

		let direction: 'asc' | 'desc' | undefined;
		if (this.match(TokenType.ASC)) {
			direction = 'asc';
		} else if (this.match(TokenType.DESC)) {
			direction = 'desc';
		}

		if (name) {
			return { name, direction };
		} else {
			return { expr, direction };
		}
	}

	/** @internal Helper to consume an IDENTIFIER token and return its lexeme */
	private consumeIdentifier(errorMessage: string): string;
	private consumeIdentifier(availableKeywords: string[], errorMessage: string): string;
	private consumeIdentifier(errorMessageOrKeywords: string | string[], errorMessage?: string): string {
		if (typeof errorMessageOrKeywords === 'string') {
			// Single parameter version - no contextual keywords
			return this.consumeIdentifierOrContextualKeyword([], errorMessageOrKeywords);
		} else {
			// Two parameter version - with contextual keywords
			return this.consumeIdentifierOrContextualKeyword(errorMessageOrKeywords, errorMessage!);
		}
	}

	/**
	 * @internal Helper to consume an IDENTIFIER token or specified contextual keywords
	 * @param availableKeywords Array of keyword strings that can be used as identifiers in this context
	 * @param errorMessage Error message if no valid token is found
	 * @returns The lexeme of the consumed token
	 */
	private consumeIdentifierOrContextualKeyword(availableKeywords: string[], errorMessage: string): string {
		const token = this.peek();

		// First check for regular identifier
		if (this.check(TokenType.IDENTIFIER)) {
			return this.advance().lexeme;
		}

		// Then check for available contextual keywords
		for (const keyword of availableKeywords) {
			const keywordUpper = keyword.toUpperCase();
			const expectedTokenType = TokenType[keywordUpper as keyof typeof TokenType];

			if (expectedTokenType && token.type === expectedTokenType) {
				// This keyword token is available as an identifier in this context
				return this.advance().lexeme;
			}
		}

		throw this.error(this.peek(), errorMessage);
	}

	/**
	 * @internal Helper to check if current token is an identifier or available contextual keyword
	 */
	private checkIdentifierLike(availableKeywords: string[] = []): boolean {
		if (this.check(TokenType.IDENTIFIER)) {
			return true;
		}

		return this.isContextualKeywordAvailable(availableKeywords);
	}

	/**
	 * @internal Helper to check if token at offset is an identifier or available contextual keyword
	 */
	private checkIdentifierLikeAt(offset: number, availableKeywords: string[] = []): boolean {
		if (this.checkNext(offset, TokenType.IDENTIFIER)) {
			return true;
		}

		if (this.current + offset >= this.tokens.length) return false;
		const token = this.tokens[this.current + offset];

		for (const keyword of availableKeywords) {
			const keywordUpper = keyword.toUpperCase();
			const expectedTokenType = TokenType[keywordUpper as keyof typeof TokenType];

			if (expectedTokenType && token.type === expectedTokenType) {
				return true;
			}
		}

		return false;
	}

	/**
	 * @internal Helper to check if any of the specified contextual keywords are available at current position
	 */
	private isContextualKeywordAvailable(availableKeywords: string[]): boolean {
		const token = this.peek();

		for (const keyword of availableKeywords) {
			const keywordUpper = keyword.toUpperCase();
			const expectedTokenType = TokenType[keywordUpper as keyof typeof TokenType];

			if (expectedTokenType && token.type === expectedTokenType) {
				return true;
			}
		}

		return false;
	}

	// --- Stubs for required helpers (implement fully for CREATE TABLE) ---

	/** @internal Parses a column definition */
	private columnDefinition(): AST.ColumnDef {
		const name = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected column name.");

		let dataType: string | undefined;
		if (this.check(TokenType.IDENTIFIER)) {
			dataType = this.advance().lexeme;
			if (this.match(TokenType.LPAREN)) {
				dataType += '(';
				let parenLevel = 1;
				while (parenLevel > 0 && !this.isAtEnd()) {
					const token = this.peek();
					if (token.type === TokenType.LPAREN) parenLevel++;
					if (token.type === TokenType.RPAREN) parenLevel--;
					if (parenLevel > 0) {
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
			this.check(TokenType.NOT) ||
			this.check(TokenType.UNIQUE) ||
			this.check(TokenType.CHECK) ||
			this.check(TokenType.DEFAULT) ||
			this.check(TokenType.COLLATE) ||
			this.check(TokenType.REFERENCES) ||
			this.check(TokenType.GENERATED);
	}

	/** @internal Parses a single column constraint */
	private columnConstraint(): AST.ColumnConstraint {
		let name: string | undefined;
		const startToken = this.peek(); // Capture start token
		let endToken = startToken; // Initialize end token

		if (this.match(TokenType.CONSTRAINT)) {
			name = this.consumeIdentifier("Expected constraint name after CONSTRAINT.");
			endToken = this.previous();
		}

		if (this.match(TokenType.PRIMARY)) {
			this.consume(TokenType.KEY, "Expected KEY after PRIMARY.");
			const direction = this.match(TokenType.ASC) ? 'asc' : this.match(TokenType.DESC) ? 'desc' : undefined;
			if (direction) endToken = this.previous();
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous(); // Update endToken if conflict clause was parsed
			const autoincrement = this.match(TokenType.AUTOINCREMENT);
			if (autoincrement) endToken = this.previous();
			return { type: 'primaryKey', name, onConflict, autoincrement, direction, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.NOT)) {
			this.consume(TokenType.NULL, "Expected NULL after NOT.");
			endToken = this.previous();
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous(); // Update endToken if conflict clause was parsed
			return { type: 'notNull', name, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.UNIQUE)) {
			endToken = this.previous();
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous(); // Update endToken if conflict clause was parsed
			return { type: 'unique', name, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.CHECK)) {
			this.consume(TokenType.LPAREN, "Expected '(' after CHECK.");
			const expr = this.expression();
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after CHECK expression.");
			// --- Parse optional ON clause --- //
			let operations: AST.RowOp[] | undefined;
			if (this.matchKeyword('ON')) {
				operations = this.parseRowOpList();
				endToken = this.previous(); // Update end token to last parsed operation or comma
			}
			// --- End Parse ON clause --- //
			return { type: 'check', name, expr, operations, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.DEFAULT)) {
			const expr = this.expression();
			endToken = this.previous();
			return { type: 'default', name, expr, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.COLLATE)) {
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected collation name after COLLATE.");
			}
			const collation = this.advance().lexeme;
			endToken = this.previous();
			return { type: 'collate', name, collation, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.REFERENCES)) {
			const fkClause = this.foreignKeyClause();
			endToken = this.previous(); // End token is end of FK clause
			return { type: 'foreignKey', name, foreignKey: fkClause, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.GENERATED)) {
			this.consume(TokenType.ALWAYS, "Expected ALWAYS after GENERATED.");
			this.consume(TokenType.AS, "Expected AS after GENERATED ALWAYS.");
			this.consume(TokenType.LPAREN, "Expected '(' after AS.");
			const expr = this.expression();
			this.consume(TokenType.RPAREN, "Expected ')' after generated expression.");
			endToken = this.previous();
			let stored = false;
			if (this.match(TokenType.STORED)) {
				stored = true;
				endToken = this.previous();
			} else if (this.match(TokenType.VIRTUAL)) {
				endToken = this.previous();
			}
			return { type: 'generated', name, generated: { expr, stored }, loc: _createLoc(startToken, endToken) };
		}

		throw this.error(this.peek(), "Expected column constraint type (PRIMARY KEY, NOT NULL, UNIQUE, CHECK, DEFAULT, COLLATE, REFERENCES, GENERATED).");
	}

	/** @internal Parses a table constraint */
	private tableConstraint(): AST.TableConstraint {
		let name: string | undefined;
		const startToken = this.peek(); // Capture start token
		let endToken = startToken; // Initialize end token

		if (this.match(TokenType.CONSTRAINT)) {
			name = this.consumeIdentifier("Expected constraint name after CONSTRAINT.");
			endToken = this.previous();
		}

		if (this.match(TokenType.PRIMARY)) {
			this.consume(TokenType.KEY, "Expected KEY after PRIMARY.");
			this.consume(TokenType.LPAREN, "Expected '(' before PRIMARY KEY columns.");
			const columns = this.identifierListWithDirection();
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after PRIMARY KEY columns.");
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			return { type: 'primaryKey', name, columns, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.UNIQUE)) {
			this.consume(TokenType.LPAREN, "Expected '(' before UNIQUE columns.");
			const columnsSimple = this.identifierList();
			const columns = columnsSimple.map(name => ({ name }));
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after UNIQUE columns.");
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			return { type: 'unique', name, columns, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.CHECK)) {
			this.consume(TokenType.LPAREN, "Expected '(' after CHECK.");
			const expr = this.expression();
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after CHECK expression.");
			// --- Parse optional ON clause --- //
			let operations: AST.RowOp[] | undefined;
			if (this.matchKeyword('ON')) {
				operations = this.parseRowOpList();
				endToken = this.previous(); // Update end token after ON clause
			}
			// --- End Parse ON clause --- //
			return { type: 'check', name, expr, operations, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.FOREIGN)) {
			this.consume(TokenType.KEY, "Expected KEY after FOREIGN.");
			this.consume(TokenType.LPAREN, "Expected '(' before FOREIGN KEY columns.");
			const columns = this.identifierList().map(name => ({ name }));
			this.consume(TokenType.RPAREN, "Expected ')' after FOREIGN KEY columns.");
			const fkClause = this.foreignKeyClause();
			endToken = this.previous(); // End token is end of FK clause
			return { type: 'foreignKey', name, columns, foreignKey: fkClause, loc: _createLoc(startToken, endToken) };
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
						initiallyDeferred = true;
					} else if (this.match(TokenType.IMMEDIATE)) {
						initiallyDeferred = false;
					} else {
						throw this.error(this.peek(), "Expected DEFERRED or IMMEDIATE after INITIALLY.");
					}
				}
			} else {
				break;
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
			identifiers.push(this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected identifier in list."));
		} while (this.match(TokenType.COMMA));
		return identifiers;
	}

	/** @internal Parses a comma-separated list of identifiers, optionally with ASC/DESC */
	private identifierListWithDirection(): { name: string; direction?: 'asc' | 'desc' }[] {
		const identifiers: { name: string; direction?: 'asc' | 'desc' }[] = [];
		do {
			const name = this.consumeIdentifier(['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'], "Expected identifier in list.");
			const direction = this.match(TokenType.ASC) ? 'asc' : this.match(TokenType.DESC) ? 'desc' : undefined;
			identifiers.push({ name, direction });
		} while (this.match(TokenType.COMMA));
		return identifiers;
	}

	// --- Helper method to peek keywords case-insensitively ---
	private peekKeyword(keyword: string): boolean {
		if (this.isAtEnd()) return false;
		const token = this.peek();

		// The keyword lookup string should be uppercase to match TokenType enum keys (e.g., TokenType.SELECT)
		const keywordKey = keyword.toUpperCase();
		const expectedTokenType = TokenType[keywordKey as keyof typeof TokenType];

		// If the keyword doesn't correspond to a known TokenType, it can't be matched this way.
		if (expectedTokenType === undefined) {
			return false;
		}

		// Check if the current token's type is the expected specific keyword TokenType.
		// This assumes the lexer has already correctly typed true keywords.
		if (token.type === expectedTokenType) {
			return true;
		}

		// Fallback: if the token is a generic IDENTIFIER, check if its lexeme matches the keyword.
		// This handles cases where a keyword might not have its own TokenType but is reserved.
		// For Quereus, most keywords DO have their own TokenType.
		if (token.type === TokenType.IDENTIFIER && token.lexeme.toUpperCase() === keywordKey) {
			// This path might indicate that the keyword was not specifically recognized by the lexer
			// or is a "soft keyword" that can also be an identifier.
			// For keywords like 'COLLATE', 'SELECT', etc., we expect them to be lexed with their specific TokenType.
			return true;
		}

		return false;
	}

	// --- Helper method to match keywords case-insensitively ---
	private matchKeyword(keyword: string): boolean {
		if (this.isAtEnd()) return false;
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

	/** Parses the list of operations for CHECK ON */
	private parseRowOpList(): AST.RowOp[] {
		const operations: AST.RowOp[] = [];
		do {
			if (this.matchKeyword('INSERT')) {
				operations.push('insert');
			} else if (this.matchKeyword('UPDATE')) {
				operations.push('update');
			} else if (this.matchKeyword('DELETE')) {
				operations.push('delete');
			} else {
				throw this.error(this.peek(), "Expected INSERT, UPDATE, or DELETE after ON.");
			}
		} while (this.match(TokenType.COMMA));
		// Optional: Check for duplicates? The design allows them but ignores them.
		return operations;
	}

	/**
	 * Parses a CASE expression
	 * CASE [base_expr] WHEN cond THEN result ... [ELSE else_result] END
	 * CASE WHEN cond THEN result ... [ELSE else_result] END
	 */
	private parseCaseExpression(startToken: Token): AST.CaseExpr {
		let baseExpr: AST.Expression | undefined;
		const whenThenClauses: AST.CaseExprWhenThenClause[] = [];
		let elseExpr: AST.Expression | undefined;
		let endToken = startToken; // Initialize with CASE token

		// Check if it's CASE expr WHEN ... or CASE WHEN ...
		if (!this.peekKeyword('WHEN')) { // Changed from checkKeyword
			baseExpr = this.expression();
		}

		while (this.matchKeyword('WHEN')) {
			const whenCondition = this.expression();
			this.consumeKeyword('THEN', "Expected 'THEN' after WHEN condition in CASE expression.");
			const thenResult = this.expression();
			whenThenClauses.push({ when: whenCondition, then: thenResult });
			endToken = this.previous(); // Update endToken to the end of the THEN expression
		}

		if (whenThenClauses.length === 0) {
			throw this.error(this.peek(), "CASE expression must have at least one WHEN clause.");
		}

		if (this.matchKeyword('ELSE')) {
			elseExpr = this.expression();
			endToken = this.previous(); // Update endToken to the end of the ELSE expression
		}

		endToken = this.consumeKeyword('END', "Expected 'END' to terminate CASE expression.");

		return {
			type: 'case',
			baseExpr,
			whenThenClauses,
			elseExpr,
			loc: _createLoc(startToken, endToken),
		};
	}

	// Helper to check if a token lexeme is a common type name keyword for CAST
	private isTypeNameKeyword(lexeme: string): boolean {
		const typeKeywords = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC', 'VARCHAR', 'CHAR', 'DATE', 'DATETIME', 'BOOLEAN', 'INT'];
		return typeKeywords.includes(lexeme.toUpperCase());
	}

	private statementSupportsWithClause(statement: AST.AstNode): boolean {
		return statement.type === 'select' ||
			   statement.type === 'insert' ||
			   statement.type === 'update' ||
			   statement.type === 'delete';
	}
}
