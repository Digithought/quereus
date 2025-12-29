/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { Database } from "../src/index.js";

describe(`Basic query`, () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it(`should execute a basic query`, async () => {
		const resultRows: Record<string, any>[] = [];
		for await (const row of db.eval(`select * from schema()`)) {
			resultRows.push(row);
		}
		// Update expectations based on what schema() actually returns.
		// For example, it might return more than one row.
		// This is a placeholder assertion.
		void expect(resultRows.length).to.be.greaterThan(0);
		const schemaEntry = resultRows.find(r => r.name === 'upper' && r.type === 'function');
		void expect(schemaEntry).to.exist;
	});

	it('should create a simple table', async () => {
		await db.exec('create table t (a text, b integer);');

		const resultRows: Record<string, any>[] = [];
		for await (const row of db.eval(`select * from schema()`)) {
			resultRows.push(row);
		}
		void expect(resultRows.length).to.be.greaterThan(0);
		const schemaEntry = resultRows.find(r => r.name === 't' && r.type === 'table');
		void expect(schemaEntry).to.exist;
	});

	describe('Parameter binding', () => {
		beforeEach(async () => {
			// Create a test table with some data
			await db.exec('CREATE TABLE test_params (id INTEGER primary key, name TEXT, value REAL)');
			await db.exec("INSERT INTO test_params VALUES (1, 'Alice', 100.5)");
			await db.exec("INSERT INTO test_params VALUES (2, 'Bob', 200.7)");
			await db.exec("INSERT INTO test_params VALUES (3, 'Charlie', 300.9)");
		});

		it('should support anonymous parameters (?)', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = ? AND name = ?');

			// Test with array parameters
			const rows1: any[] = [];
			for await (const row of stmt.all([2, "Bob"])) {
				rows1.push(row);
			}
			void expect(rows1).to.have.length(1);
			void expect(rows1[0].id).to.equal(2);
			void expect(rows1[0].name).to.equal("Bob");
			void expect(rows1[0].value).to.equal(200.7);

			await stmt.finalize();
		});

		it('should support indexed parameters (:1, :2)', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = :1 AND name = :2');

			// Test with object parameters using numeric keys
			const rows: any[] = [];
			for await (const row of stmt.all({1: 3, 2: "Charlie"})) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(3);
			void expect(rows[0].name).to.equal("Charlie");
			void expect(rows[0].value).to.equal(300.9);

			await stmt.finalize();
		});

		it('should support named parameters (:name)', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = :user_id AND name = :user_name');

			// Test with object parameters using named keys
			const rows: any[] = [];
			for await (const row of stmt.all({user_id: 1, user_name: "Alice"})) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(1);
			void expect(rows[0].name).to.equal("Alice");
			void expect(rows[0].value).to.equal(100.5);

			await stmt.finalize();
		});

		it('should support mixed parameter types', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id > ? AND value < :max_value');

			// Test with mixed parameters - key 1 for first ?, named for :max_value
			const rows: any[] = [];
			for await (const row of stmt.all({1: 1, max_value: 250})) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(2);
			void expect(rows[0].name).to.equal("Bob");

			await stmt.finalize();
		});

		it('should support parameter binding via bind methods', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = :id');

			stmt.bind('id', 2);

			const rows: any[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(2);
			void expect(rows[0].name).to.equal("Bob");

			await stmt.finalize();
		});

		it('should support bindAll with object', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = :id AND name = :name');

			stmt.bindAll({id: 3, name: "Charlie"});

			const rows: any[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(3);

			await stmt.finalize();
		});

		it('should support bindAll with array', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = ? AND name = ?');

			stmt.bindAll([1, "Alice"]);

			const rows: any[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(1);

			await stmt.finalize();
		});

		it('should support parameters in db.eval()', async () => {
			const rows: any[] = [];
			for await (const row of db.eval('SELECT * FROM test_params WHERE id = ? AND name = ?', [2, "Bob"])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(2);
			void expect(rows[0].name).to.equal("Bob");
		});

		it('should handle null parameters', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE name = ?');

			const rows: any[] = [];
			for await (const row of stmt.all([null])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(0); // No matches for NULL name

			await stmt.finalize();
		});

		it('should handle different data types as parameters', async () => {
			await db.exec('CREATE TABLE type_test (id INTEGER, flag BOOLEAN, data BLOB)');

			const stmt = db.prepare('INSERT INTO type_test VALUES (?, ?, ?)');
			await stmt.run([42, true, new Uint8Array([1, 2, 3])]);
			await stmt.finalize();

			const selectStmt = db.prepare('SELECT * FROM type_test WHERE id = ? AND flag = ?');
			const rows: any[] = [];
			for await (const row of selectStmt.all([42, true])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(42);
			void expect(rows[0].flag).to.equal(true);
			void expect(rows[0].data).to.be.instanceof(Uint8Array);

			await selectStmt.finalize();
		});

		it('should update NULL column to non-NULL value with parameterized SET and WHERE', async () => {
			// Regression test: UPDATE with both SET and WHERE parameterized failed
			// because parameter indices were assigned in wrong order (WHERE before SET)
			await db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, description TEXT NULL)');
			await db.exec('INSERT INTO items (id, name, description) VALUES (?, ?, ?)', ['item-1', 'Coffee', null]);

			// Verify initial value is null
			const beforeRows: any[] = [];
			for await (const row of db.eval('SELECT description FROM items WHERE id = ?', ['item-1'])) {
				beforeRows.push(row);
			}
			void expect(beforeRows).to.have.length(1);
			void expect(beforeRows[0].description).to.equal(null);

			// Update with parameterized SET and WHERE - this was the failing case
			await db.exec('UPDATE items SET description = ? WHERE id = ?', ['dddd', 'item-1']);

			// Verify update was applied
			const afterRows: any[] = [];
			for await (const row of db.eval('SELECT description FROM items WHERE id = ?', ['item-1'])) {
				afterRows.push(row);
			}
			void expect(afterRows).to.have.length(1);
			void expect(afterRows[0].description).to.equal('dddd');
		});
	});
});
