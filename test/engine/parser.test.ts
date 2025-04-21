import { Parser } from '../../src/parser/parser';
import { TokenType } from '../../src/parser/lexer';
import { ParseError } from '../../src/parser/parser';
import type { SelectStmt, ColumnExpr, BinaryExpr, LiteralExpr } from '../../src/parser/ast';
import { assert } from 'chai';

describe('SQL Parser', () => {
	let parser: Parser;

	beforeEach(() => {
		parser = new Parser();
	});

	describe('SELECT statements', () => {
		it('should parse a simple SELECT', () => {
			const ast = parser.parse('SELECT id, name FROM users') as SelectStmt;

			assert.equal(ast.type, 'select');
			assert.equal(ast.columns.length, 2);
			assert.equal(ast.columns[0].type, 'column');
			assert.equal((ast.columns[0] as any).expr.name, 'id');
			assert.equal(ast.columns[1].type, 'column');
			assert.equal((ast.columns[1] as any).expr.name, 'name');
			assert.equal(ast.from?.length, 1);
			assert.equal(ast.from?.[0].type, 'table');
			assert.equal((ast.from?.[0] as any).table.name, 'users');
		});

		it('should parse SELECT with WHERE clause', () => {
			const ast = parser.parse('SELECT name FROM users WHERE age > 30') as SelectStmt;

			assert.equal(ast.type, 'select');
			assert.exists(ast.where);
			assert.equal((ast.where as BinaryExpr).type, 'binary');
			assert.equal((ast.where as BinaryExpr).operator, '>');
			assert.equal(((ast.where as BinaryExpr).left as ColumnExpr).name, 'age');
			assert.equal(((ast.where as BinaryExpr).right as LiteralExpr).value, 30);
		});

		it('should parse SELECT with multiple conditions', () => {
			const ast = parser.parse(
				'SELECT name FROM users WHERE age > 30 AND active = 1'
			) as SelectStmt;

			assert.equal(ast.type, 'select');
			assert.exists(ast.where);
			assert.equal((ast.where as BinaryExpr).type, 'binary');
			assert.equal((ast.where as BinaryExpr).operator, 'AND');
		});

		it('should parse SELECT with ORDER BY', () => {
			const ast = parser.parse(
				'SELECT name FROM users ORDER BY age DESC, name ASC'
			) as SelectStmt;

			assert.equal(ast.type, 'select');
			assert.exists(ast.orderBy);
			assert.equal(ast.orderBy?.length, 2);
			assert.equal(ast.orderBy?.[0].direction, 'desc');
			assert.equal(((ast.orderBy?.[0].expr) as ColumnExpr).name, 'age');
			assert.equal(ast.orderBy?.[1].direction, 'asc');
			assert.equal(((ast.orderBy?.[1].expr) as ColumnExpr).name, 'name');
		});

		it('should parse SELECT with LIMIT', () => {
			const ast = parser.parse(
				'SELECT name FROM users LIMIT 10'
			) as SelectStmt;

			assert.equal(ast.type, 'select');
			assert.exists(ast.limit);
			assert.equal((ast.limit as LiteralExpr).value, 10);
		});

		it('should parse SELECT with LIMIT OFFSET', () => {
			const ast = parser.parse(
				'SELECT name FROM users LIMIT 10 OFFSET 20'
			) as SelectStmt;

			assert.equal(ast.type, 'select');
			assert.exists(ast.limit);
			assert.equal((ast.limit as LiteralExpr).value, 10);
			assert.exists(ast.offset);
			assert.equal((ast.offset as LiteralExpr).value, 20);
		});

		it('should parse SELECT with aliases', () => {
			const ast = parser.parse(
				'SELECT u.name AS username FROM users u'
			) as SelectStmt;

			assert.equal(ast.type, 'select');
			assert.equal(ast.columns.length, 1);
			assert.equal(ast.columns[0].type, 'column');
			assert.equal((ast.columns[0] as any).alias, 'username');
			assert.equal(((ast.columns[0] as any).expr as ColumnExpr).table, 'u');

			assert.equal(ast.from?.length, 1);
			assert.equal((ast.from?.[0] as any).alias, 'u');
		});

		it('should parse SELECT with JOIN', () => {
			const ast = parser.parse(
				'SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id'
			) as SelectStmt;

			assert.equal(ast.type, 'select');
			assert.equal(ast.from?.length, 1);
			assert.equal(ast.from?.[0].type, 'join');

			const join = ast.from?.[0] as any;
			assert.equal(join.joinType, 'inner');
			assert.equal(join.left.type, 'table');
			assert.equal(join.left.table.name, 'users');
			assert.equal(join.left.alias, 'u');
			assert.equal(join.right.type, 'table');
			assert.equal(join.right.table.name, 'orders');
			assert.equal(join.right.alias, 'o');

			assert.exists(join.condition);
			assert.equal(join.condition.type, 'binary');
			assert.equal(join.condition.operator, '=');
		});
	});

	describe('Error handling', () => {
		it('should throw error for invalid syntax', () => {
			assert.throws(() => {
				parser.parse('SELECT FROM users');
			}, ParseError);

			assert.throws(() => {
				parser.parse('SEL name FROM users');
			}, ParseError);

			assert.throws(() => {
				parser.parse('SELECT name FORM users');
			}, ParseError);
		});
	});
});
