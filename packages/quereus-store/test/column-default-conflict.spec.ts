/**
 * Tests for column-level / table-level ON CONFLICT defaults in StoreTable.
 *
 * Exercises StoreModule directly (without the isolation layer overlay) so the
 * three-tier precedence `statement OR > per-constraint default > ABORT` is
 * observable inside StoreTable.update. The isolation-wrapped path is covered
 * by the engine's logic tests (29.1-column-level-conflict-clause.sqllogic).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

describe('StoreTable column-level ON CONFLICT defaults', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('INSERT with PRIMARY KEY ON CONFLICT REPLACE', () => {
		it('silently replaces an existing row at the duplicate PK', async () => {
			await db.exec(`
				CREATE TABLE pk_replace (
					a INTEGER PRIMARY KEY ON CONFLICT REPLACE,
					b TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO pk_replace VALUES (1, 'first')`);
			await db.exec(`INSERT INTO pk_replace VALUES (1, 'second')`);

			const rows = await collect(db, `SELECT a, b FROM pk_replace`);
			expect(rows).to.deep.equal([{ a: 1, b: 'second' }]);
		});
	});

	describe('INSERT with PRIMARY KEY ON CONFLICT IGNORE', () => {
		it('silently drops the duplicate INSERT', async () => {
			await db.exec(`
				CREATE TABLE pk_ignore (
					a INTEGER PRIMARY KEY ON CONFLICT IGNORE,
					b TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO pk_ignore VALUES (10, 'data')`);
			await db.exec(`INSERT INTO pk_ignore VALUES (10, 'conflict')`);

			const rows = await collect(db, `SELECT a, b FROM pk_ignore`);
			expect(rows).to.deep.equal([{ a: 10, b: 'data' }]);
		});
	});

	describe('INSERT with UNIQUE ON CONFLICT REPLACE', () => {
		it('replaces the existing row that owns the duplicate UNIQUE value', async () => {
			await db.exec(`
				CREATE TABLE uniq_replace (
					id INTEGER PRIMARY KEY,
					email TEXT UNIQUE ON CONFLICT REPLACE
				) USING store
			`);
			await db.exec(`INSERT INTO uniq_replace VALUES (1, 'a@x')`);
			await db.exec(`INSERT INTO uniq_replace VALUES (2, 'a@x')`);

			const rows = await collect(db, `SELECT id, email FROM uniq_replace ORDER BY id`);
			expect(rows).to.deep.equal([{ id: 2, email: 'a@x' }]);
		});
	});

	describe('UPDATE PK-change with PRIMARY KEY ON CONFLICT REPLACE', () => {
		it('evicts the row at the colliding PK and moves the updated row in', async () => {
			await db.exec(`
				CREATE TABLE pk_upd_replace (
					id INTEGER PRIMARY KEY ON CONFLICT REPLACE,
					v TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO pk_upd_replace VALUES (1, 'a')`);
			await db.exec(`INSERT INTO pk_upd_replace VALUES (2, 'b')`);

			// No statement-level OR — column-level REPLACE should apply.
			await db.exec(`UPDATE pk_upd_replace SET id = 2 WHERE id = 1`);

			const rows = await collect(db, `SELECT id, v FROM pk_upd_replace ORDER BY id`);
			expect(rows).to.deep.equal([{ id: 2, v: 'a' }]);
		});
	});

	describe('UPDATE PK-change with PRIMARY KEY ON CONFLICT IGNORE', () => {
		it('drops the UPDATE silently when the new PK is occupied', async () => {
			await db.exec(`
				CREATE TABLE pk_upd_ignore (
					id INTEGER PRIMARY KEY ON CONFLICT IGNORE,
					v TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO pk_upd_ignore VALUES (1, 'a')`);
			await db.exec(`INSERT INTO pk_upd_ignore VALUES (2, 'b')`);

			await db.exec(`UPDATE pk_upd_ignore SET id = 2 WHERE id = 1`);

			const rows = await collect(db, `SELECT id, v FROM pk_upd_ignore ORDER BY id`);
			expect(rows).to.deep.equal([
				{ id: 1, v: 'a' },
				{ id: 2, v: 'b' },
			]);
		});
	});

	describe('statement-level OR overrides column-level directive', () => {
		// UPDATE OR <action> is intentionally not supported by the parser
		// (see logic/47.2 §5 and docs/sql.md §11), so the only statement-level
		// override path is INSERT OR <action>.
		it('INSERT OR ABORT defeats column-level ON CONFLICT IGNORE', async () => {
			await db.exec(`
				CREATE TABLE override_t (
					a INTEGER PRIMARY KEY ON CONFLICT IGNORE,
					b TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO override_t VALUES (1, 'first')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT OR ABORT INTO override_t VALUES (1, 'second')`);
			} catch (e) {
				err = e as Error;
			}
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);

			const rows = await collect(db, `SELECT a, b FROM override_t`);
			expect(rows).to.deep.equal([{ a: 1, b: 'first' }]);
		});
	});

	describe('UPDATE PK-change REPLACE cascades ON DELETE for evicted row', () => {
		it('CASCADE deletes children of the evicted row', async () => {
			// Quereus's default ON UPDATE is RESTRICT, so any child of the moved
			// row would block the update before eviction can happen. Only the
			// row that gets evicted has a child here.
			await db.exec(`
				CREATE TABLE parent_evict (
					id INTEGER PRIMARY KEY ON CONFLICT REPLACE,
					v TEXT
				) USING store
			`);
			await db.exec(`
				CREATE TABLE child_evict (
					id INTEGER PRIMARY KEY,
					parent_id INTEGER REFERENCES parent_evict(id) ON DELETE CASCADE
				) USING store
			`);
			await db.exec(`INSERT INTO parent_evict VALUES (1, 'one')`);
			await db.exec(`INSERT INTO parent_evict VALUES (2, 'two')`);
			await db.exec(`INSERT INTO child_evict VALUES (20, 2)`);

			await db.exec(`UPDATE parent_evict SET id = 2 WHERE id = 1`);

			const children = await collect(db, `SELECT id, parent_id FROM child_evict`);
			expect(children).to.deep.equal([]);

			const parents = await collect(db, `SELECT id, v FROM parent_evict ORDER BY id`);
			expect(parents).to.deep.equal([{ id: 2, v: 'one' }]);
		});
	});

});
