/**
 * Tests for ALTER TABLE operations on store-backed tables.
 *
 * Validates eager row migration for ADD/DROP COLUMN and
 * schema-only updates for RENAME COLUMN.
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
		async closeStore(_schemaName: string, _tableName: string) {
			// No-op for in-memory stores
		},
		async closeIndexStore(_schemaName: string, _tableName: string, _indexName: string) {
			// No-op for in-memory stores
		},
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
		async renameTableStores(schemaName: string, oldName: string, newName: string) {
			const oldKey = `${schemaName}.${oldName}`;
			const newKey = `${schemaName}.${newName}`;
			const dataStore = stores.get(oldKey);
			if (dataStore) {
				stores.delete(oldKey);
				stores.set(newKey, dataStore);
			}
			const oldIndexPrefix = `${schemaName}.${oldName}_idx_`;
			const newIndexPrefix = `${schemaName}.${newName}_idx_`;
			for (const key of Array.from(stores.keys())) {
				if (key.startsWith(oldIndexPrefix)) {
					const suffix = key.substring(oldIndexPrefix.length);
					const store = stores.get(key)!;
					stores.delete(key);
					stores.set(newIndexPrefix + suffix, store);
				}
			}
		},
	};
}

describe('Store ALTER TABLE', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(async () => {
		db = new Database();
		provider = createInMemoryProvider();
		const storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('ADD COLUMN', () => {
		it('adds a column to a populated table with null default', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);
			await db.exec(`INSERT INTO items VALUES (2, 'Gadget')`);

			await db.exec(`ALTER TABLE items ADD COLUMN price REAL`);

			const rows = await asyncIterableToArray(db.eval('select id, name, price from items order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, name: 'Widget', price: null });
			expect(rows[1]).to.deep.equal({ id: 2, name: 'Gadget', price: null });
		});

		it('adds a column with a DEFAULT value', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);

			await db.exec(`ALTER TABLE items ADD COLUMN active INTEGER DEFAULT 1`);

			const row = await db.get('select * from items where id = 1');
			expect(row?.active).to.equal(1);
		});

		it('new inserts include the added column', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Old')`);

			await db.exec(`ALTER TABLE items ADD COLUMN color TEXT`);
			await db.exec(`INSERT INTO items VALUES (2, 'New', 'red')`);

			const rows = await asyncIterableToArray(db.eval('select * from items order by id'));
			expect(rows[0]).to.deep.equal({ id: 1, name: 'Old', color: null });
			expect(rows[1]).to.deep.equal({ id: 2, name: 'New', color: 'red' });
		});

		it('adds a column to an empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			await db.exec(`ALTER TABLE items ADD COLUMN extra TEXT`);
			await db.exec(`INSERT INTO items VALUES (1, 'test', 'val')`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'test', extra: 'val' });
		});

		it('allows NOT NULL without DEFAULT on an empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			await db.exec(`ALTER TABLE items ADD COLUMN rank INTEGER NOT NULL`);
			await db.exec(`INSERT INTO items VALUES (1, 'Alice', 10)`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'Alice', rank: 10 });
		});

		it('refuses NOT NULL without DEFAULT on a non-empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Alice')`);

			let caught: unknown = null;
			try {
				await db.exec(`ALTER TABLE items ADD COLUMN rank INTEGER NOT NULL`);
			} catch (e) {
				caught = e;
			}

			expect(caught).to.be.instanceOf(Error);
			const message = (caught as Error).message;
			expect(message).to.include(`'rank'`);
			expect(message).to.include('main.items');
			expect(message).to.not.include('__rekey_');
		});

		it('allows NOT NULL with literal DEFAULT on a non-empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Alice')`);

			await db.exec(`ALTER TABLE items ADD COLUMN score INTEGER NOT NULL DEFAULT 0`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'Alice', score: 0 });
		});
	});

	describe('DROP COLUMN', () => {
		it('drops a non-PK column from a populated table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT,
					description TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget', 'A fine widget')`);
			await db.exec(`INSERT INTO items VALUES (2, 'Gadget', 'A cool gadget')`);

			await db.exec(`ALTER TABLE items DROP COLUMN description`);

			const rows = await asyncIterableToArray(db.eval('select * from items order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, name: 'Widget' });
			expect(rows[1]).to.deep.equal({ id: 2, name: 'Gadget' });
		});

		it('drops a column from an empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT,
					extra TEXT
				) USING store
			`);

			await db.exec(`ALTER TABLE items DROP COLUMN extra`);
			await db.exec(`INSERT INTO items VALUES (1, 'test')`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'test' });
		});

		it('preserves PK lookups after dropping a column', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					a TEXT,
					b TEXT,
					c TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'x', 'y', 'z')`);

			await db.exec(`ALTER TABLE items DROP COLUMN b`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, a: 'x', c: 'z' });
		});

		it('preserves PK when dropping a column before the PK', async () => {
			await db.exec(`
				CREATE TABLE items (
					label TEXT,
					id INTEGER,
					extra TEXT,
					PRIMARY KEY(id)
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES ('Widget', 1, 'x')`);
			await db.exec(`INSERT INTO items VALUES ('Gadget', 2, 'y')`);

			await db.exec(`ALTER TABLE items DROP COLUMN label`);

			const rows = await asyncIterableToArray(db.eval('select * from items order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, extra: 'x' });
			expect(rows[1]).to.deep.equal({ id: 2, extra: 'y' });

			// Inserts after drop must use the PK correctly (not overwrite each other)
			await db.exec(`INSERT INTO items VALUES (3, 'z')`);
			await db.exec(`INSERT INTO items VALUES (4, 'w')`);
			const allRows = await asyncIterableToArray(db.eval('select * from items order by id'));
			expect(allRows).to.have.lengthOf(4);
		});
	});

	describe('RENAME COLUMN', () => {
		it('renames a column preserving data', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);

			await db.exec(`ALTER TABLE items RENAME COLUMN name TO title`);

			const row = await db.get('select id, title from items where id = 1');
			expect(row).to.deep.equal({ id: 1, title: 'Widget' });
		});

		it('allows inserts using the new column name', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			await db.exec(`ALTER TABLE items RENAME COLUMN name TO title`);
			await db.exec(`INSERT INTO items (id, title) VALUES (1, 'Test')`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, title: 'Test' });
		});
	});

	describe('RENAME TABLE', () => {
		it('renames a populated table and preserves data', async () => {
			await db.exec(`
				CREATE TABLE t_rename (
					id INTEGER PRIMARY KEY,
					val TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO t_rename VALUES (1, 'a'), (2, 'b')`);

			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);

			const rows = await asyncIterableToArray(db.eval('select * from t_renamed order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, val: 'a' });
			expect(rows[1]).to.deep.equal({ id: 2, val: 'b' });
		});

		it('allows inserts under the new name after rename', async () => {
			await db.exec(`
				CREATE TABLE t_rename (
					id INTEGER PRIMARY KEY,
					val TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO t_rename VALUES (1, 'a')`);

			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);
			await db.exec(`INSERT INTO t_renamed VALUES (2, 'b')`);

			const rows = await asyncIterableToArray(db.eval('select * from t_renamed order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, val: 'a' });
			expect(rows[1]).to.deep.equal({ id: 2, val: 'b' });
		});

		it('rejects renaming the old name after rename', async () => {
			await db.exec(`
				CREATE TABLE t_rename (
					id INTEGER PRIMARY KEY,
					val TEXT
				) USING store
			`);
			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);

			let caught: unknown = null;
			try {
				await db.exec(`SELECT * FROM t_rename`);
			} catch (e) {
				caught = e;
			}
			expect(caught).to.be.instanceOf(Error);
		});

		it('rejects rename to an existing table', async () => {
			await db.exec(`
				CREATE TABLE t_a (id INTEGER PRIMARY KEY) USING store
			`);
			await db.exec(`
				CREATE TABLE t_b (id INTEGER PRIMARY KEY) USING store
			`);

			let caught: unknown = null;
			try {
				await db.exec(`ALTER TABLE t_a RENAME TO t_b`);
			} catch (e) {
				caught = e;
			}
			expect(caught).to.be.instanceOf(Error);
			expect((caught as Error).message).to.match(/already exists/i);
		});

		it('rewrites the persistent catalog DDL under the new name', async () => {
			const storeModule = new StoreModule(provider);
			db.registerModule('store_rename_ddl', storeModule);

			await db.exec(`
				CREATE TABLE t_before (
					id INTEGER PRIMARY KEY,
					val TEXT
				) USING store_rename_ddl
			`);
			await db.exec(`ALTER TABLE t_before RENAME TO t_after`);

			const ddlStatements = await storeModule.loadAllDDL();
			expect(ddlStatements).to.have.lengthOf(1);
			expect(ddlStatements[0].toLowerCase()).to.include('t_after');
			expect(ddlStatements[0].toLowerCase()).to.not.include('t_before');
		});
	});

	describe('sequential ALTER TABLE operations', () => {
		it('handles add, rename, then drop in sequence', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);

			// Add a column
			await db.exec(`ALTER TABLE items ADD COLUMN color TEXT`);
			let row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'Widget', color: null });

			// Rename the original column
			await db.exec(`ALTER TABLE items RENAME COLUMN name TO title`);
			row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, title: 'Widget', color: null });

			// Drop the added column
			await db.exec(`ALTER TABLE items DROP COLUMN color`);
			row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, title: 'Widget' });
		});

		it('handles multiple add columns sequentially', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1)`);

			await db.exec(`ALTER TABLE items ADD COLUMN a TEXT`);
			await db.exec(`ALTER TABLE items ADD COLUMN b INTEGER DEFAULT 42`);
			await db.exec(`ALTER TABLE items ADD COLUMN c TEXT`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, a: null, b: 42, c: null });
		});

		it('handles add then drop of the same column', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);

			await db.exec(`ALTER TABLE items ADD COLUMN scratch TEXT`);
			await db.exec(`ALTER TABLE items DROP COLUMN scratch`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'Widget' });
		});
	});

	describe('DDL persistence', () => {
		it('persists updated DDL after ADD COLUMN', async () => {
			const storeModule = new StoreModule(provider);
			db.registerModule('store2', storeModule);

			await db.exec(`
				CREATE TABLE items2 (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store2
			`);
			await db.exec(`INSERT INTO items2 VALUES (1, 'Widget')`);
			await db.exec(`ALTER TABLE items2 ADD COLUMN color TEXT`);

			// Load DDL and verify it reflects the new schema
			const ddlStatements = await storeModule.loadAllDDL();
			expect(ddlStatements).to.have.lengthOf(1);
			expect(ddlStatements[0]).to.include('color');
		});
	});
});
