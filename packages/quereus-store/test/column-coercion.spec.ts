/**
 * Tests for declared column-type coercion on INSERT/UPDATE in StoreTable.
 *
 * Exercises StoreModule directly (without the isolation layer overlay) so that
 * StoreTable.update's coerceRow path is observable. Mirrors the memory-path
 * semantics (MemoryTableManager.performInsert/performUpdate) — INTEGER/REAL
 * affinity and JSON normalization should both be applied before the row is
 * serialized and before PK/index keys are derived.
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

function createInMemoryProvider(): KVStoreProvider & { stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		stores,
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

describe('StoreTable column type coercion', () => {
	let db: Database;
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('INTEGER affinity', () => {
		it("coerces string '100' to number 100 on INSERT", async () => {
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING store`);
			await db.exec(`INSERT INTO t VALUES (1, '100')`);
			const row = await db.get(`SELECT n, typeof(n) as tn FROM t WHERE id = 1`);
			expect(row?.n).to.equal(100);
			expect(row?.tn).to.equal('integer');
		});

		it('rejects non-numeric string for INTEGER column', async () => {
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING store`);
			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t VALUES (1, 'abc')`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/Type/i);
		});

		it('coerces on UPDATE path', async () => {
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING store`);
			await db.exec(`INSERT INTO t VALUES (1, 10)`);
			await db.exec(`UPDATE t SET n = '42' WHERE id = 1`);
			const row = await db.get(`SELECT n, typeof(n) as tn FROM t WHERE id = 1`);
			expect(row?.n).to.equal(42);
			expect(row?.tn).to.equal('integer');
		});
	});

	describe('REAL affinity', () => {
		it("coerces string '2.71' to number 2.71 on INSERT", async () => {
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, r REAL) USING store`);
			await db.exec(`INSERT INTO t VALUES (1, '2.71')`);
			const row = await db.get(`SELECT r, typeof(r) as tr FROM t WHERE id = 1`);
			expect(row?.r).to.equal(2.71);
			expect(row?.tr).to.equal('real');
		});
	});

	describe('TEXT affinity', () => {
		it('coerces number 42 to string "42" on INSERT', async () => {
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) USING store`);
			await db.exec(`INSERT INTO t VALUES (1, 42)`);
			const row = await db.get(`SELECT s, typeof(s) as ts FROM t WHERE id = 1`);
			expect(row?.s).to.equal('42');
			expect(row?.ts).to.equal('text');
		});
	});

	describe('PK coercion', () => {
		it("INSERT '1' into INTEGER PK then query WHERE pk = 1 finds the row", async () => {
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING store`);
			await db.exec(`INSERT INTO t VALUES ('1', 'a')`);
			const row = await db.get(`SELECT id, typeof(id) as tid, v FROM t WHERE id = 1`);
			expect(row?.id).to.equal(1);
			expect(row?.tid).to.equal('integer');
			expect(row?.v).to.equal('a');
		});
	});

	describe('JSON type', () => {
		it('parses JSON text on INSERT and typeof reports json', async () => {
			await db.exec(`CREATE TABLE j (id INTEGER PRIMARY KEY, doc JSON) USING store`);
			await db.exec(`INSERT INTO j VALUES (1, '{"a":1}')`);
			const row = await db.get(`SELECT typeof(doc) as td FROM j WHERE id = 1`);
			expect(row?.td).to.equal('json');
			const rows = await collect(db, `SELECT doc FROM j WHERE id = 1`);
			expect(rows[0].doc).to.deep.equal({ a: 1 });
		});

		it('rejects invalid JSON text on INSERT', async () => {
			await db.exec(`CREATE TABLE j (id INTEGER PRIMARY KEY, doc JSON) USING store`);
			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO j VALUES (1, 'not-json-{')`);
			} catch (e) { err = e as Error; }
			expect(err).to.not.be.null;
		});
	});

	describe('persistence round-trip', () => {
		it('INTEGER column is stored as a number, not raw text', async () => {
			const db1 = new Database();
			const mod1 = new StoreModule(provider);
			db1.registerModule('store', mod1);
			await db1.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING store`);
			await db1.exec(`INSERT INTO t VALUES (1, '100')`);

			const db2 = new Database();
			const mod2 = new StoreModule(provider);
			db2.registerModule('store', mod2);
			await mod2.rehydrateCatalog(db2);

			const row = await db2.get(`SELECT n, typeof(n) as tn FROM t WHERE id = 1`);
			expect(row?.n).to.equal(100);
			expect(row?.tn).to.equal('integer');
		});

		it('JSON column round-trips as a native object', async () => {
			const db1 = new Database();
			const mod1 = new StoreModule(provider);
			db1.registerModule('store', mod1);
			await db1.exec(`CREATE TABLE j (id INTEGER PRIMARY KEY, doc JSON) USING store`);
			await db1.exec(`INSERT INTO j VALUES (1, '{"a":1,"b":[2,3]}')`);

			const db2 = new Database();
			const mod2 = new StoreModule(provider);
			db2.registerModule('store', mod2);
			await mod2.rehydrateCatalog(db2);

			const rows = await collect(db2, `SELECT doc, typeof(doc) as td FROM j WHERE id = 1`);
			expect(rows[0].td).to.equal('json');
			expect(rows[0].doc).to.deep.equal({ a: 1, b: [2, 3] });
		});
	});
});
