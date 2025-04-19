/**
 * SQL Parser for SQLiter
 *
 * Implements a recursive descent parser for SQL statements
 * with initial focus on SELECT statements
 */

import { Lexer, type Token, TokenType } from './lexer';
import type {
  AstNode,
  Expression,
  LiteralExpr,
  IdentifierExpr,
  ColumnExpr,
  BinaryExpr,
  FunctionExpr,
  ParameterExpr,
  SelectStmt,
  InsertStmt,
  ResultColumn,
  FromClause,
  TableSource,
  OrderByClause,
  JoinClause
} from './ast';

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
  parse(sql: string): AstNode {
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
  private statement(): AstNode {
    if (this.match(TokenType.SELECT)) {
      return this.selectStatement();
    }

    if (this.match(TokenType.INSERT)) {
      return this.insertStatement();
    }

    throw this.error(this.peek(), 'Expected statement. Currently supporting SELECT and INSERT.');
  }

  /**
   * Parse an INSERT statement
   * @returns AST for the INSERT statement
   */
  insertStatement(): InsertStmt {
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
    let values: Expression[][] | undefined;
    let select: SelectStmt | undefined;

    if (this.match(TokenType.VALUES)) {
      values = [];
      do {
        this.consume(TokenType.LPAREN, "Expected '(' before values.");
        const valueList: Expression[] = [];

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
  selectStatement(): SelectStmt {
    const distinct = this.match(TokenType.DISTINCT);
    const all = !distinct && this.match(TokenType.ALL);

    // Parse column list
    const columns = this.columnList();

    // Parse FROM clause if present
    let from: FromClause[] | undefined;
    if (this.match(TokenType.FROM)) {
      from = this.tableSourceList();
    }

    // Parse WHERE clause if present
    let where: Expression | undefined;
    if (this.match(TokenType.WHERE)) {
      where = this.expression();
    }

    // Parse GROUP BY clause if present
    let groupBy: Expression[] | undefined;
    if (this.match(TokenType.GROUP) && this.consume(TokenType.BY, "Expected 'BY' after 'GROUP'.")) {
      groupBy = [];
      do {
        groupBy.push(this.expression());
      } while (this.match(TokenType.COMMA));
    }

    // Parse HAVING clause if present
    let having: Expression | undefined;
    if (this.match(TokenType.HAVING)) {
      having = this.expression();
    }

    // Parse ORDER BY clause if present
    let orderBy: OrderByClause[] | undefined;
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
    let limit: Expression | undefined;
    let offset: Expression | undefined;
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
    let union: SelectStmt | undefined;
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
  private columnList(): ResultColumn[] {
    const columns: ResultColumn[] = [];

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
  private tableIdentifier(): IdentifierExpr {
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
  private tableSourceList(): FromClause[] {
    const sources: FromClause[] = [];

    do {
      // Get the base table source
      let source: FromClause = this.tableSource();

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
  private tableSource(): TableSource {
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
  private joinClause(left: FromClause): JoinClause {
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
    let condition: Expression | undefined;
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
  private expression(): Expression {
    return this.logicalOr();
  }

  /**
   * Parse logical OR expression
   */
  private logicalOr(): Expression {
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
  private logicalAnd(): Expression {
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
  private equality(): Expression {
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
  private comparison(): Expression {
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
  private term(): Expression {
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
  private factor(): Expression {
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
  private primary(): Expression {
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

      const args: Expression[] = [];
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
}
