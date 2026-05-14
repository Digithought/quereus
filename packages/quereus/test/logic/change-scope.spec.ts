import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	deserializeChangeScope,
	serializeChangeScope,
	type WatchScope,
	type ParamScopeValue,
} from '../../src/planner/analysis/change-scope.js';

describe('Statement.getChangeScope (integration)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('two prepared statements over equivalent SQL produce deepEqual scopes', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const a = db.prepare('select * from t where id = ?').getChangeScope([5]);
		const b = db.prepare('select * from t where id = ?').getChangeScope([5]);
		expect(a.unboundParameters).to.deep.equal(b.unboundParameters);
		expect(a.watches.length).to.equal(b.watches.length);
		expect(a.watches[0].scope).to.deep.equal(b.watches[0].scope);
		expect(a.watches[0].table).to.deep.equal(b.watches[0].table);
	});

	it('serialized scope round-trips and matches the live one', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const live = db.prepare('select v from t where id = ?').getChangeScope();
		const round = deserializeChangeScope(JSON.parse(JSON.stringify(serializeChangeScope(live))));
		expect(round.unboundParameters).to.deep.equal(live.unboundParameters);
		expect(round.watches[0].table).to.deep.equal(live.watches[0].table);
		expect(round.watches[0].scope).to.deep.equal(live.watches[0].scope);
	});

	it('parameter placeholders carry a portable type descriptor', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		const scope = stmt.getChangeScope();
		const w = scope.watches[0];
		expect(w.scope.kind).to.equal('rows');
		const r = w.scope as Extract<WatchScope, { kind: 'rows' }>;
		const v = r.values[0][0] as ParamScopeValue;
		expect(v.kind).to.equal('param');
		expect(v.type).to.have.property('typeName').that.is.a('string');
		expect(v.type).to.have.property('nullable');
	});

	it('getChangeScope on Statement without prior bind returns scope with unbound params', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		const scope = stmt.getChangeScope();
		expect(scope.unboundParameters).to.deep.equal([1]);
	});

	it('getChangeScope on prepared statement with bound params resolves placeholders', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		stmt.bind(1, 99);
		const scope = stmt.getChangeScope();
		expect(scope.unboundParameters).to.deep.equal([]);
		const r = scope.watches[0].scope as Extract<WatchScope, { kind: 'rows' }>;
		expect(r.values).to.deep.equal([[99]]);
	});
});
