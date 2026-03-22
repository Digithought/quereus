import { expect } from 'chai';
import { parse } from '../src/parser/index.js';
import { traverseAst, type AstVisitorCallbacks } from '../src/parser/visitor.js';
import type { AstNode } from '../src/parser/ast.js';

/** Collect all node types visited via enterNode */
function collectTypes(sql: string): string[] {
	const ast = parse(sql);
	const types: string[] = [];
	traverseAst(ast, {
		enterNode(node: AstNode) {
			types.push(node.type);
		},
	});
	return types;
}

describe('traverseAst', () => {
	describe('traversal control flow', () => {
		it('traverses all children when enterNode returns void', () => {
			const types = collectTypes('select 1, 2');
			expect(types).to.include('select');
			expect(types).to.include('literal');
			expect(types.filter(t => t === 'literal')).to.have.length(2);
		});

		it('stops traversal of a branch when enterNode returns false', () => {
			const ast = parse('select 1 + 2');
			const types: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
					// Stop traversal at binary nodes — should not visit children
					if (node.type === 'binary') return false;
				},
			});
			expect(types).to.include('select');
			expect(types).to.include('binary');
			// The literals under the binary should NOT be visited
			expect(types).to.not.include('literal');
		});

		it('continues traversal when enterNode returns true', () => {
			const types: string[] = [];
			const ast = parse('select 1');
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
					return true;
				},
			});
			expect(types).to.include('select');
			expect(types).to.include('literal');
		});

		it('stops branch when specific visitor returns false', () => {
			const ast = parse('select 1 + 2');
			const types: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
				},
				visitSelect() {
					return false; // Stop — should not visit children of select
				},
			});
			// enterNode sees the select, but visitSelect stops further traversal
			expect(types).to.deep.equal(['select']);
		});

		it('calls exitNode after traversing children', () => {
			const ast = parse('select 1');
			const events: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					events.push(`enter:${node.type}`);
				},
				exitNode(node: AstNode) {
					events.push(`exit:${node.type}`);
				},
			});
			expect(events).to.deep.equal([
				'enter:select',
				'enter:literal',
				'exit:literal',
				'exit:select',
			]);
		});

		it('does not call exitNode when enterNode returns false', () => {
			const ast = parse('select 1');
			const events: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					events.push(`enter:${node.type}`);
					return false; // Stop at select
				},
				exitNode(node: AstNode) {
					events.push(`exit:${node.type}`);
				},
			});
			expect(events).to.deep.equal(['enter:select']);
		});
	});

	describe('expression node types', () => {
		it('traverses CASE expression children', () => {
			const types = collectTypes('select case x when 1 then 2 when 3 then 4 else 5 end from t');
			expect(types).to.include('case');
			// base expr (x), when values, then values, else value
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(5);
		});

		it('traverses CASE expression without base expr', () => {
			const types = collectTypes('select case when x > 1 then 2 else 3 end from t');
			expect(types).to.include('case');
			expect(types).to.include('binary'); // x > 1
		});

		it('traverses IN expression with values list', () => {
			const types = collectTypes('select x in (1, 2, 3) from t');
			expect(types).to.include('in');
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(3);
		});

		it('traverses IN expression with subquery', () => {
			const types = collectTypes('select x in (select id from t2) from t');
			expect(types).to.include('in');
			// The subquery select should be traversed
			const selects = types.filter(t => t === 'select');
			expect(selects.length).to.equal(2);
		});

		it('traverses EXISTS expression', () => {
			const types = collectTypes('select exists(select 1 from t) from t');
			expect(types).to.include('exists');
			const selects = types.filter(t => t === 'select');
			expect(selects.length).to.equal(2);
		});

		it('traverses BETWEEN expression', () => {
			const types = collectTypes('select x between 1 and 10 from t');
			expect(types).to.include('between');
			const literals = types.filter(t => t === 'literal');
			expect(literals.length).to.be.greaterThanOrEqual(2);
		});
	});

	describe('WITH clause (CTE) traversal', () => {
		it('traverses CTEs in SELECT', () => {
			const types = collectTypes('with cte as (select 1) select * from cte');
			const selects = types.filter(t => t === 'select');
			// The outer select and the CTE select
			expect(selects.length).to.equal(2);
		});
	});

	describe('handles undefined/null nodes gracefully', () => {
		it('does nothing for undefined node', () => {
			const types: string[] = [];
			traverseAst(undefined, {
				enterNode(node: AstNode) {
					types.push(node.type);
				},
			});
			expect(types).to.be.empty;
		});
	});
});
