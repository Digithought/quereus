import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { snapshotSchema } from '../src/schema-bridge.js';

describe('snapshotSchema', () => {
	it('returns empty snapshot for fresh database', () => {
		const db = new Database();
		const snap = snapshotSchema(db);
		expect(snap).to.have.property('tables').that.is.an('array');
		expect(snap).to.have.property('functions').that.is.an('array');
		expect(snap.tables).to.have.length(0);
	});

	it('captures table names and columns after CREATE TABLE', async () => {
		const db = new Database();
		await db.exec('create table users (id integer primary key, name text, email text)');
		const snap = snapshotSchema(db);
		expect(snap.tables).to.have.length(1);
		const tbl = snap.tables[0];
		expect(tbl.name).to.equal('users');
		expect(tbl.schema).to.equal('main');
		expect(tbl.columns).to.deep.equal(['id', 'name', 'email']);
	});

	it('captures multiple tables', async () => {
		const db = new Database();
		await db.exec('create table orders (id integer primary key, total real)');
		await db.exec('create table items (id integer primary key, order_id integer, product text)');
		const snap = snapshotSchema(db);
		expect(snap.tables).to.have.length(2);
		const names = snap.tables.map(t => t.name).sort();
		expect(names).to.deep.equal(['items', 'orders']);
	});

	it('functions array is currently empty', () => {
		const db = new Database();
		const snap = snapshotSchema(db);
		expect(snap.functions).to.deep.equal([]);
	});

	it('reflects dropped tables', async () => {
		const db = new Database();
		await db.exec('create table temp_tbl (id integer primary key)');
		expect(snapshotSchema(db).tables).to.have.length(1);
		await db.exec('drop table temp_tbl');
		expect(snapshotSchema(db).tables).to.have.length(0);
	});
});

