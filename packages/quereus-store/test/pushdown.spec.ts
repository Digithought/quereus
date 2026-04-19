/**
 * Predicate-pushdown tests for StoreModule.getBestAccessPlan.
 *
 * Regression: getBestAccessPlan must only mark range filters as `handled`
 * when they target the leading PK column, because the legacy access-path
 * planner only forwards range bounds for primaryKeyDefinition[0]. Marking a
 * non-leading PK range as handled would cause the residual predicate to be
 * silently dropped — particularly visible on tables without an explicit
 * PRIMARY KEY (where every column becomes a PK column).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();

	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			const key = `${schemaName}.${tableName}_idx_${indexName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getStatsStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}.__stats__`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getCatalogStore() {
			const key = '__catalog__';
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async closeStore(_schemaName: string, _tableName: string) {},
		async closeIndexStore(_schemaName: string, _tableName: string, _indexName: string) {},
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
	};
}

describe('StoreModule predicate pushdown', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		const storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('explicit PRIMARY KEY (id)', () => {
		beforeEach(async () => {
			await db.exec(`
				create table users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER) using store
			`);
			await db.exec(`insert into users values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35)`);
		});

		it('range on PK column id returns correct rows (range-scan path)', async () => {
			const rows = await asyncIterableToArray(db.eval(`select id, name from users where id > 1 order by id`));
			expect(rows).to.deep.equal([
				{ id: 2, name: 'Bob' },
				{ id: 3, name: 'Carol' },
			]);
		});

		it('range on non-PK column age returns correct rows (residual on full scan)', async () => {
			const rows = await asyncIterableToArray(db.eval(`select age, name from users where age > 25 order by age`));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
				{ age: 35, name: 'Carol' },
			]);
		});
	});

	describe('table without explicit PRIMARY KEY', () => {
		beforeEach(async () => {
			// No PK declared — every column becomes part of the implicit PK.
			await db.exec(`
				create table users (id INTEGER, name TEXT, age INTEGER) using store
			`);
			await db.exec(`insert into users values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35)`);
		});

		it('range on first column id returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select id, name from users where id > 1 order by id`));
			expect(rows).to.deep.equal([
				{ id: 2, name: 'Bob' },
				{ id: 3, name: 'Carol' },
			]);
		});

		// Regression: under the old behavior, getBestAccessPlan would mark this
		// range as handled even though the legacy planner only forwards ranges
		// on the first PK column — so the predicate was silently dropped and
		// every row was returned.
		it('range on non-first column age returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select age, name from users where age > 25 order by age`));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
				{ age: 35, name: 'Carol' },
			]);
		});

		it('compound predicate (range + LIKE) on non-first column returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(
				`select age, name from users where age > 25 and name like 'A%' order by age`
			));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
			]);
		});
	});
});
