/**
 * Tests for FK cascade operations with KVStore-backed tables.
 *
 * Verifies that ON DELETE CASCADE properly removes child rows when
 * using the store module (as opposed to in-memory vtab).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	StoreEventEmitter,
	type KVStoreProvider,
	type DataChangeEvent,
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

describe('FK cascade with store module', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('ON DELETE CASCADE', () => {
		beforeEach(async () => {
			const storeModule = new StoreModule(provider);
			db.registerModule('store', storeModule);

			await db.exec('PRAGMA foreign_keys = true');

			await db.exec(`
				CREATE TABLE parent (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			await db.exec(`
				CREATE TABLE child (
					id INTEGER PRIMARY KEY,
					parent_id INTEGER,
					info TEXT,
					FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
				) USING store
			`);

			// Populate data
			await db.exec(`INSERT INTO parent VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO parent VALUES (2, 'Bob')`);
			await db.exec(`INSERT INTO child VALUES (10, 1, 'child A1')`);
			await db.exec(`INSERT INTO child VALUES (20, 1, 'child A2')`);
			await db.exec(`INSERT INTO child VALUES (30, 2, 'child B1')`);
		});

		it('removes child rows when parent is deleted', async () => {
			await db.exec(`DELETE FROM parent WHERE id = 1`);

			// Child rows for parent 1 should be gone
			const childCount = await db.get(`SELECT count(*) as cnt FROM child WHERE parent_id = 1`);
			expect(childCount?.cnt).to.equal(0);

			// Child rows for parent 2 should remain
			const remainingCount = await db.get(`SELECT count(*) as cnt FROM child WHERE parent_id = 2`);
			expect(remainingCount?.cnt).to.equal(1);

			// Parent 2 should still exist
			const parent2 = await db.get(`SELECT * FROM parent WHERE id = 2`);
			expect(parent2?.name).to.equal('Bob');
		});

		it('removes all child rows when all parents are deleted', async () => {
			await db.exec(`DELETE FROM parent`);

			const childCount = await db.get(`SELECT count(*) as cnt FROM child`);
			expect(childCount?.cnt).to.equal(0);
		});

		it('cascades through multiple levels', async () => {
			await db.exec(`
				CREATE TABLE grandchild (
					id INTEGER PRIMARY KEY,
					child_id INTEGER,
					detail TEXT,
					FOREIGN KEY (child_id) REFERENCES child(id) ON DELETE CASCADE
				) USING store
			`);

			await db.exec(`INSERT INTO grandchild VALUES (100, 10, 'gc1')`);
			await db.exec(`INSERT INTO grandchild VALUES (200, 20, 'gc2')`);
			await db.exec(`INSERT INTO grandchild VALUES (300, 30, 'gc3')`);

			// Delete parent 1 — should cascade to child 10, 20 → grandchild 100, 200
			await db.exec(`DELETE FROM parent WHERE id = 1`);

			const gcCount = await db.get(`SELECT count(*) as cnt FROM grandchild`);
			expect(gcCount?.cnt).to.equal(1);

			const remaining = await db.get(`SELECT * FROM grandchild WHERE id = 300`);
			expect(remaining?.detail).to.equal('gc3');
		});
	});

	describe('ON DELETE CASCADE events', () => {
		it('emits data change events for cascaded child deletes', async () => {
			const events: DataChangeEvent[] = [];
			const emitter = new StoreEventEmitter();
			emitter.onDataChange((event) => events.push(event));
			const storeModule = new StoreModule(provider, emitter);
			db.registerModule('store', storeModule);

			await db.exec('PRAGMA foreign_keys = true');

			await db.exec(`
				CREATE TABLE parent (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			await db.exec(`
				CREATE TABLE child (
					id INTEGER PRIMARY KEY,
					parent_id INTEGER,
					info TEXT,
					FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
				) USING store
			`);

			await db.exec(`INSERT INTO parent VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO child VALUES (10, 1, 'child A1')`);
			await db.exec(`INSERT INTO child VALUES (20, 1, 'child A2')`);

			// Clear events from inserts
			events.length = 0;

			await db.exec(`DELETE FROM parent WHERE id = 1`);

			// Should have events for child deletes + parent delete
			const deleteEvents = events.filter(e => e.type === 'delete');
			expect(deleteEvents.length).to.be.gte(3);

			const childDeletes = deleteEvents.filter(e => e.tableName === 'child');
			expect(childDeletes.length).to.equal(2);

			const parentDeletes = deleteEvents.filter(e => e.tableName === 'parent');
			expect(parentDeletes.length).to.equal(1);
		});
	});
});
