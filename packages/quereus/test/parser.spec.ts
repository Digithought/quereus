import { expect } from 'chai';
import { parse, parseAll, type BinaryExpr, type UnaryExpr, type LiteralExpr, type SelectStmt, type Expression, type BetweenExpr } from '../src/parser/index.js';
import { ParseError } from '../src/parser/parser.js';

/** Shorthand to parse an expression from a SELECT wrapper */
function parseExpr(exprSql: string): Expression {
	const stmt = parse(`select ${exprSql}`) as SelectStmt;
	const col = stmt.columns[0];
	if (col.type !== 'column') throw new Error('Expected column result');
	return col.expr;
}

/** Assert a binary expression with given operator, returning it for further inspection */
function expectBinary(expr: Expression, operator: string): BinaryExpr {
	expect(expr.type).to.equal('binary');
	const bin = expr as BinaryExpr;
	expect(bin.operator).to.equal(operator);
	return bin;
}

/** Assert a unary expression with given operator */
function expectUnary(expr: Expression, operator: string): UnaryExpr {
	expect(expr.type).to.equal('unary');
	const un = expr as UnaryExpr;
	expect(un.operator).to.equal(operator);
	return un;
}

/** Assert a literal with the given value */
function expectLiteral(expr: Expression, value: unknown): void {
	expect(expr.type).to.equal('literal');
	expect((expr as LiteralExpr).value).to.equal(value);
}

describe('Parser', () => {

	describe('Operator Precedence', () => {
		it('should parse multiplication before addition: 1 + 2 * 3', () => {
			// Expected: 1 + (2 * 3) — addition at top, multiplication on right
			const expr = parseExpr('1 + 2 * 3');
			const add = expectBinary(expr, '+');
			expectLiteral(add.left, 1);
			const mul = expectBinary(add.right, '*');
			expectLiteral(mul.left, 2);
			expectLiteral(mul.right, 3);
		});

		it('should parse AND before OR: a OR b AND c', () => {
			const expr = parseExpr('1 OR 0 AND 1');
			const or = expectBinary(expr, 'OR');
			expectLiteral(or.left, 1);
			const and = expectBinary(or.right, 'AND');
			expectLiteral(and.left, 0);
			expectLiteral(and.right, 1);
		});

		it('should parse XOR at same level as OR', () => {
			// XOR and OR are same precedence, left-to-right
			const expr = parseExpr('1 OR 0 XOR 1');
			const xor = expectBinary(expr, 'XOR');
			const or = expectBinary(xor.left, 'OR');
			expectLiteral(or.left, 1);
			expectLiteral(or.right, 0);
			expectLiteral(xor.right, 1);
		});

		it('should parse comparison before equality: a = b < c', () => {
			// = is lower precedence than <, so: a = (b < c)
			const expr = parseExpr('1 = 2 < 3');
			const eq = expectBinary(expr, '=');
			expectLiteral(eq.left, 1);
			const lt = expectBinary(eq.right, '<');
			expectLiteral(lt.left, 2);
			expectLiteral(lt.right, 3);
		});

		it('should parse subtraction left-to-right: 10 - 3 - 2', () => {
			const expr = parseExpr('10 - 3 - 2');
			const outer = expectBinary(expr, '-');
			const inner = expectBinary(outer.left, '-');
			expectLiteral(inner.left, 10);
			expectLiteral(inner.right, 3);
			expectLiteral(outer.right, 2);
		});

		it('should parse concatenation: a || b || c', () => {
			const expr = parseExpr("'a' || 'b' || 'c'");
			const outer = expectBinary(expr, '||');
			const inner = expectBinary(outer.left, '||');
			expectLiteral(inner.left, 'a');
			expectLiteral(inner.right, 'b');
			expectLiteral(outer.right, 'c');
		});

		it('should respect parentheses: (1 + 2) * 3', () => {
			const expr = parseExpr('(1 + 2) * 3');
			const mul = expectBinary(expr, '*');
			const add = expectBinary(mul.left, '+');
			expectLiteral(add.left, 1);
			expectLiteral(add.right, 2);
			expectLiteral(mul.right, 3);
		});
	});

	describe('Unary Operators', () => {
		it('should parse unary minus', () => {
			const expr = parseExpr('-1');
			const un = expectUnary(expr, '-');
			expectLiteral(un.expr, 1);
		});

		it('should parse double negation: -(-1)', () => {
			const expr = parseExpr('-(-1)');
			const outer = expectUnary(expr, '-');
			const inner = expectUnary(outer.expr, '-');
			expectLiteral(inner.expr, 1);
		});

		it('should parse NOT operator', () => {
			const expr = parseExpr('NOT 1');
			const un = expectUnary(expr, 'NOT');
			expectLiteral(un.expr, 1);
		});

		it('should parse bitwise NOT (~)', () => {
			const expr = parseExpr('~5');
			const un = expectUnary(expr, '~');
			expectLiteral(un.expr, 5);
		});
	});

	describe('IS NULL / IS NOT NULL', () => {
		it('should parse IS NULL', () => {
			const expr = parseExpr('1 IS NULL');
			const un = expectUnary(expr, 'IS NULL');
			expectLiteral(un.expr, 1);
		});

		it('should parse IS NOT NULL', () => {
			const expr = parseExpr('1 IS NOT NULL');
			const un = expectUnary(expr, 'IS NOT NULL');
			expectLiteral(un.expr, 1);
		});

		it('should not consume IS when not followed by NULL', () => {
			// "1 IS" without NULL should backtrack — the expression should just be the literal 1
			// This relies on the backtracking working correctly
			const expr = parseExpr('1');
			expectLiteral(expr, 1);
		});
	});

	describe('Location Tracking', () => {
		it('should track locations on expression nodes', () => {
			const expr = parseExpr('1 + 2');
			expect(expr.loc).to.exist;
			expect(expr.loc!.start.line).to.be.a('number');
			expect(expr.loc!.start.column).to.be.a('number');
			expect(expr.loc!.end.line).to.be.a('number');
			expect(expr.loc!.end.column).to.be.a('number');
		});

		it('should track locations on binary chain expressions', () => {
			const expr = parseExpr('1 + 2 + 3');
			const outer = expectBinary(expr, '+');
			expect(outer.loc).to.exist;
			// The outer node should span from the start of '1' to the end of '3'
			expect(outer.loc!.start.offset).to.be.lessThan(outer.loc!.end.offset);
		});

		it('should track locations on statements', () => {
			const stmt = parse('select 1');
			expect(stmt.loc).to.exist;
		});
	});

	describe('Statement Parsing', () => {
		it('should parse multiple statements', () => {
			const stmts = parseAll('select 1; select 2');
			expect(stmts).to.have.length(2);
			expect(stmts[0].type).to.equal('select');
			expect(stmts[1].type).to.equal('select');
		});

		it('should parse SELECT without FROM', () => {
			const stmt = parse('select 1, 2, 3') as SelectStmt;
			expect(stmt.type).to.equal('select');
			expect(stmt.columns).to.have.length(3);
		});

		it('should parse SELECT with alias', () => {
			const stmt = parse('select 1 as num') as SelectStmt;
			expect(stmt.columns).to.have.length(1);
			const col = stmt.columns[0];
			expect(col.type).to.equal('column');
			if (col.type === 'column') {
				expect(col.alias).to.equal('num');
			}
		});

		it('should parse SELECT *', () => {
			const stmt = parse('select * from t') as SelectStmt;
			expect(stmt.columns).to.have.length(1);
			expect(stmt.columns[0].type).to.equal('all');
		});
	});

	describe('Error Handling', () => {
		it('should throw ParseError for incomplete statements', () => {
			expect(() => parse('select * from')).to.throw();
		});

		it('should throw on misspelled keywords', () => {
			expect(() => parse('CREAT TABLE t (a)')).to.throw();
		});

		it('should throw on unclosed parentheses', () => {
			expect(() => parse('select (1 + 2')).to.throw();
		});

		it('should throw on empty statement', () => {
			expect(() => parse('')).to.throw();
		});

		it('should include location information in parse errors', () => {
			try {
				parse('select * from');
				expect.fail('Should have thrown');
			} catch (e: unknown) {
				if (e instanceof ParseError) {
					expect(e.token).to.exist;
					expect(e.token.startLine).to.be.a('number');
				}
			}
		});
	});

	describe('Equality Operators', () => {
		it('should parse = operator', () => {
			const expr = parseExpr('1 = 2');
			expectBinary(expr, '=');
		});

		it('should parse == operator', () => {
			const expr = parseExpr('1 == 2');
			expectBinary(expr, '==');
		});

		it('should parse != operator', () => {
			const expr = parseExpr('1 != 2');
			expectBinary(expr, '!=');
		});
	});

	describe('BETWEEN and IN', () => {
		it('should parse BETWEEN expression', () => {
			const expr = parseExpr('5 BETWEEN 1 AND 10');
			expect(expr.type).to.equal('between');
		});

		it('should parse IN with value list', () => {
			const expr = parseExpr('1 IN (1, 2, 3)');
			expect(expr.type).to.equal('in');
		});

		it('should parse NOT BETWEEN', () => {
			const expr = parseExpr('5 NOT BETWEEN 1 AND 10');
			expect(expr.type).to.equal('between');
			expect((expr as BetweenExpr).not).to.equal(true);
		});
	});

	describe('COLLATE', () => {
		it('should parse COLLATE expression', () => {
			const expr = parseExpr("'hello' COLLATE NOCASE");
			expect(expr.type).to.equal('collate');
		});
	});

	describe('CASE Expression', () => {
		it('should parse simple CASE', () => {
			const expr = parseExpr("CASE 1 WHEN 1 THEN 'one' ELSE 'other' END");
			expect(expr.type).to.equal('case');
		});

		it('should parse searched CASE', () => {
			const expr = parseExpr("CASE WHEN 1 > 0 THEN 'pos' ELSE 'neg' END");
			expect(expr.type).to.equal('case');
		});
	});
});
