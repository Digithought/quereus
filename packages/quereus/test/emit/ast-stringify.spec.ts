import { expect } from 'chai';
import { parse } from '../../src/parser/index.js';
import { createTableToString, createViewToString } from '../../src/emit/ast-stringify.js';
import type { CreateTableStmt, CreateViewStmt, SelectStmt, TableConstraint } from '../../src/parser/ast.js';

/**
 * These tests pin the AST round-trip — parse → stringify → parse — at the
 * unit level, not just string equality. The previous round-trip suite
 * (`emit-roundtrip.spec.ts`) compared stringified output to stringified
 * output, which silently passed when the stringifier dropped a field
 * symmetrically. Walking the post-reparse AST exposes those drops.
 */
describe('Emit: ast-stringify AST round-trip', () => {

	describe('CHECK operations (issue #23)', () => {
		const findCheck = (cs: readonly TableConstraint[], name: string): TableConstraint => {
			const c = cs.find(x => x.type === 'check' && x.name === name);
			if (!c) throw new Error(`Expected named CHECK constraint '${name}' in re-parsed table`);
			return c;
		};

		it('preserves table-level `check on delete (...)` operations list', () => {
			const sql = 'create table T (Id int, primary key (Id), constraint X check on delete (false))';

			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted, 'emitted SQL should contain `on delete`').to.match(/check\s+on\s+delete\s*\(/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			const cons = findCheck(reparsed.constraints, 'X');
			expect(cons.operations).to.deep.equal(['delete']);
		});

		it('preserves table-level `check on update (...)` operations list', () => {
			const sql = 'create table T (Id int, Val int, primary key (Id), constraint Y check on update (new.Val >= 0))';

			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted).to.match(/check\s+on\s+update\s*\(/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			expect(findCheck(reparsed.constraints, 'Y').operations).to.deep.equal(['update']);
		});

		it('preserves multi-op `check on insert, update (...)` operations list', () => {
			const sql = 'create table T (Id int, primary key (Id), constraint Z check on insert, update (Id > 0))';

			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			// Both ops survive in order.
			expect(emitted).to.match(/check\s+on\s+insert\s*,\s*update\s*\(/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			expect(findCheck(reparsed.constraints, 'Z').operations).to.deep.equal(['insert', 'update']);
		});

		it('preserves inline-column CHECK ON operations list', () => {
			const sql = 'create table T (Id int constraint NoDel check on delete (false), primary key (Id))';

			const original = parse(sql) as CreateTableStmt;
			const emitted = createTableToString(original);
			expect(emitted).to.match(/check\s+on\s+delete\s*\(/i);

			const reparsed = parse(emitted) as CreateTableStmt;
			const colConstraints = reparsed.columns[0].constraints;
			const check = colConstraints.find(c => c.type === 'check');
			expect(check, 'inline check constraint should survive').to.exist;
			expect(check!.operations).to.deep.equal(['delete']);
		});
	});

	describe('Compound SELECT (issue #21)', () => {
		it('preserves all four legs of a UNION ALL chain through view DDL', () => {
			const sql = "create view V as select 'a' as Code union all select 'b' as Code union all select 'c' as Code union all select 'd' as Code";

			const original = parse(sql) as CreateViewStmt;
			const emitted = createViewToString(original);
			// All four literal codes survive in the emitted SQL.
			expect(emitted).to.include("'a'");
			expect(emitted).to.include("'b'");
			expect(emitted).to.include("'c'");
			expect(emitted).to.include("'d'");

			const reparsed = parse(emitted) as CreateViewStmt;
			// Walk the linked compound chain and collect each leg's literal.
			const codes: string[] = [];
			let cursor: SelectStmt | undefined = reparsed.select;
			while (cursor) {
				const col = cursor.columns[0];
				if (col.type !== 'column' || col.expr.type !== 'literal') {
					throw new Error('Expected literal-string projection per leg');
				}
				codes.push(String(col.expr.value));
				cursor = cursor.compound?.select;
			}
			expect(codes).to.deep.equal(['a', 'b', 'c', 'd']);
		});

		it('preserves UNION (DISTINCT) keyword', () => {
			const sql = 'create view V as select 1 as N union select 2 as N';
			const original = parse(sql) as CreateViewStmt;
			const emitted = createViewToString(original);
			// `union all` would be wrong here.
			expect(emitted).to.match(/\bunion\b/i);
			expect(emitted).to.not.match(/\bunion\s+all\b/i);

			const reparsed = parse(emitted) as CreateViewStmt;
			expect(reparsed.select.compound?.op).to.equal('union');
		});

		it('preserves INTERSECT and EXCEPT', () => {
			for (const op of ['intersect', 'except'] as const) {
				const sql = `create view V as select 1 as N ${op} select 2 as N`;
				const reparsed = parse(createViewToString(parse(sql) as CreateViewStmt)) as CreateViewStmt;
				expect(reparsed.select.compound?.op, `op for ${op}`).to.equal(op);
			}
		});
	});
});
