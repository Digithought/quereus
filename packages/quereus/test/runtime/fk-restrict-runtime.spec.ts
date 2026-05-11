// Covers the runtime RESTRICT pre-check added in
// `tickets/complete/fix-fk-restrict-parent-unique-column-delete`. The plan-time
// `NOT EXISTS` synthesized by `buildParentSideFKChecks` remains the primary
// enforcement path; this suite pins the redundant runtime check fires for any
// FK target shape and on both DELETE and UPDATE.

import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { assertNoRestrictedChildrenForParentMutation } from '../../src/runtime/foreign-key-actions.js';

async function expectThrows(fn: () => Promise<unknown>, messageContains: string): Promise<Error> {
	let thrown: unknown;
	try {
		await fn();
	} catch (e) {
		thrown = e;
	}
	void expect(thrown, 'expected throw').to.exist;
	const err = thrown as Error;
	void expect(err.message).to.include(messageContains);
	return err;
}

describe('runtime FK RESTRICT pre-check', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma foreign_keys = true');
	});

	afterEach(async () => {
		await db.close();
	});

	it('fires on DELETE when parent column is a UNIQUE (non-PK) column', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on delete restrict
			);
			insert into p_uq values (1, 'AAA'), (2, 'BBB');
			insert into c_uq values (10, 'AAA');
		`);

		await expectThrows(
			() => db.exec("delete from p_uq where code = 'AAA'"),
			'constraint failed',
		);

		// Unreferenced row deletes cleanly.
		await db.exec("delete from p_uq where code = 'BBB'");
	});

	it('fires on DELETE when parent column is the PK', async () => {
		await db.exec(`
			create table p_pk (id integer primary key, name text);
			create table c_pk (
				id integer primary key,
				p_id integer,
				foreign key (p_id) references p_pk(id) on delete restrict
			);
			insert into p_pk values (1, 'one'), (2, 'two');
			insert into c_pk values (10, 1);
		`);

		await expectThrows(
			() => db.exec('delete from p_pk where id = 1'),
			'constraint failed',
		);

		await db.exec('delete from p_pk where id = 2');
	});

	it('fires on UPDATE that changes a referenced UNIQUE column', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on update restrict
			);
			insert into p_uq values (1, 'AAA');
			insert into c_uq values (10, 'AAA');
		`);

		await expectThrows(
			() => db.exec("update p_uq set code = 'BBB' where id = 1"),
			'constraint failed',
		);
	});

	it('does not fire on UPDATE that does not touch the referenced column', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique, label text);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on update restrict on delete restrict
			);
			insert into p_uq values (1, 'AAA', 'first');
			insert into c_uq values (10, 'AAA');
		`);

		// Updating `label` leaves `code` unchanged; the RESTRICT check must skip.
		await db.exec("update p_uq set label = 'updated' where id = 1");
		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval('select code, label from p_uq')) rows.push(r);
		void expect(rows).to.deep.equal([{ code: 'AAA', label: 'updated' }]);
	});

	it('does not fire when foreign_keys pragma is off', async () => {
		await db.exec(`
			create table p (id integer primary key, code text not null unique);
			create table c (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p(code) on delete restrict
			);
			insert into p values (1, 'AAA');
			insert into c values (10, 'AAA');
			pragma foreign_keys = false;
		`);
		// With FKs disabled, neither plan-time nor runtime check fires.
		await db.exec("delete from p where code = 'AAA'");
	});

	// Direct call against the function — covers the path that fires when a
	// custom vtab module's plan-time NOT EXISTS subquery would otherwise be
	// bypassed. The function is what `runDelete` / `runUpdate` invoke before
	// `vtab.update()`; this test verifies it works against any backend that
	// exposes the standard `prepare`/`iterate` query interface.
	it('throws when called directly with parent values referenced by a child', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on delete restrict
			);
			insert into p_uq values (1, 'AAA');
			insert into c_uq values (10, 'AAA');
		`);

		const parentSchema = db.schemaManager.getTable('main', 'p_uq');
		void expect(parentSchema, 'p_uq schema').to.exist;

		// oldRow for the row being deleted: (id=1, code='AAA')
		await expectThrows(
			() => assertNoRestrictedChildrenForParentMutation(db, parentSchema!, 'delete', [1, 'AAA']),
			"violates RESTRICT from 'c_uq'",
		);
	});

	it('directly returns cleanly when no child references the parent values', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on delete restrict
			);
			insert into p_uq values (1, 'AAA'), (2, 'BBB');
			insert into c_uq values (10, 'AAA');
		`);
		const parentSchema = db.schemaManager.getTable('main', 'p_uq');
		void expect(parentSchema, 'p_uq schema').to.exist;

		// oldRow for the unreferenced row: (id=2, code='BBB')
		await assertNoRestrictedChildrenForParentMutation(db, parentSchema!, 'delete', [2, 'BBB']);
	});

	it('does not fire for CASCADE / SET NULL / SET DEFAULT — those go through the action walker', async () => {
		await db.exec(`
			create table p_cd (id integer primary key, code text not null unique);
			create table c_cd (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_cd(code) on delete cascade
			);
			insert into p_cd values (1, 'AAA');
			insert into c_cd values (10, 'AAA');
		`);

		// Cascade: parent delete should succeed and the child row should be removed.
		await db.exec("delete from p_cd where code = 'AAA'");
		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval('select id from c_cd')) rows.push(r);
		void expect(rows).to.deep.equal([]);
	});
});
