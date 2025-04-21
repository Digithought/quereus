import { Database } from '../../src/core/database';
import { MemoryTableModule } from '../../src/vtab/memory-table';
import { StatusCode } from '../../src/common/types';
import assert from 'assert';

describe('MemoryTableModule', () => {
	let db: Database;
	let memoryModule: MemoryTableModule;

	beforeEach(async () => {
		db = new Database();
		memoryModule = new MemoryTableModule();
		db.registerVtabModule('memory', memoryModule);

		await db.exec(`
      CREATE VIRTUAL TABLE test_table USING memory(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        value INTEGER,
        metadata TEXT
      )
    `);
	});

	afterEach(async () => {
		await db.close();
	});

	it('should create a memory table with the correct schema', async () => {
		const stmt = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name='test_table'");
		const result = await stmt.step();

		assert.strictEqual(result, StatusCode.ROW);
		const row = stmt.getAsObject();
		assert.strictEqual(row.name, 'test_table');
		assert.ok(row.sql.includes('CREATE VIRTUAL TABLE test_table USING memory'));

		await stmt.finalize();
	});

	it('should insert and retrieve rows', async () => {
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item1', 100, 'test data 1')");
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item2', 200, 'test data 2')");

		const rows: any[] = [];
		await db.exec("SELECT * FROM test_table", (row, columns) => {
			rows.push(row);
		});

		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows[0].name, 'item1');
		assert.strictEqual(rows[0].value, 100);
		assert.strictEqual(rows[0].metadata, 'test data 1');
		assert.strictEqual(rows[1].name, 'item2');
		assert.strictEqual(rows[1].value, 200);
		assert.strictEqual(rows[1].metadata, 'test data 2');
	});

	it('should update rows', async () => {
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item1', 100, 'test data 1')");
		await db.exec("UPDATE test_table SET value = 150, metadata = 'updated data' WHERE name = 'item1'");

		const stmt = await db.prepare("SELECT * FROM test_table WHERE name = 'item1'");
		const result = await stmt.step();

		assert.strictEqual(result, StatusCode.ROW);
		const row = stmt.getAsObject();
		assert.strictEqual(row.value, 150);
		assert.strictEqual(row.metadata, 'updated data');

		await stmt.finalize();
	});

	it('should delete rows', async () => {
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item1', 100, 'test data 1')");
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item2', 200, 'test data 2')");
		await db.exec("DELETE FROM test_table WHERE name = 'item1'");

		const rows: any[] = [];
		await db.exec("SELECT * FROM test_table", (row, columns) => {
			rows.push(row);
		});

		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].name, 'item2');
		assert.strictEqual(rows[0].value, 200);
	});

	it('should filter rows based on constraints', async () => {
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item1', 100, 'test data 1')");
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item2', 200, 'test data 2')");
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item3', 300, 'test data 3')");

		const rows: any[] = [];
		await db.exec("SELECT * FROM test_table WHERE value > 150", (row, columns) => {
			rows.push(row);
		});

		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows[0].name, 'item2');
		assert.strictEqual(rows[1].name, 'item3');
	});

	it('should handle primary key constraints', async () => {
		await db.exec("INSERT INTO test_table (id, name, value) VALUES (1, 'item1', 100)");

		try {
			await db.exec("INSERT INTO test_table (id, name, value) VALUES (1, 'item2', 200)");
			assert.fail('Should have thrown a primary key constraint error');
		} catch (error: any) {
			assert.ok(error.message.includes('PRIMARY KEY constraint failed'));
		}
	});

	it('should work with transactions', async () => {
		await db.exec("BEGIN TRANSACTION");
		await db.exec("INSERT INTO test_table (name, value) VALUES ('tx_item1', 100)");
		await db.exec("INSERT INTO test_table (name, value) VALUES ('tx_item2', 200)");
		await db.exec("COMMIT");

		const rows: any[] = [];
		await db.exec("SELECT * FROM test_table", (row, columns) => {
			rows.push(row);
		});

		assert.strictEqual(rows.length, 2);

		// Test rollback
		await db.exec("BEGIN TRANSACTION");
		await db.exec("INSERT INTO test_table (name, value) VALUES ('tx_item3', 300)");

		const rowsDuringTx: any[] = [];
		await db.exec("SELECT * FROM test_table", (row, columns) => {
			rowsDuringTx.push(row);
		});
		assert.strictEqual(rowsDuringTx.length, 3);

		await db.exec("ROLLBACK");

		const rowsAfterRollback: any[] = [];
		await db.exec("SELECT * FROM test_table", (row, columns) => {
			rowsAfterRollback.push(row);
		});
		assert.strictEqual(rowsAfterRollback.length, 2);
	});

	it('should handle complex queries', async () => {
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item1', 100, 'test')");
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item2', 200, 'test')");
		await db.exec("INSERT INTO test_table (name, value, metadata) VALUES ('item3', 300, 'other')");

		const rows: any[] = [];
		await db.exec("SELECT * FROM test_table WHERE value > 100 AND metadata = 'test'", (row, columns) => {
			rows.push(row);
		});

		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].name, 'item2');
		assert.strictEqual(rows[0].value, 200);
	});

	it('should handle ORDER BY clauses', async () => {
		await db.exec("INSERT INTO test_table (name, value) VALUES ('c', 300)");
		await db.exec("INSERT INTO test_table (name, value) VALUES ('a', 100)");
		await db.exec("INSERT INTO test_table (name, value) VALUES ('b', 200)");

		const rows: any[] = [];
		await db.exec("SELECT * FROM test_table ORDER BY name ASC", (row, columns) => {
			rows.push(row);
		});

		assert.strictEqual(rows.length, 3);
		assert.strictEqual(rows[0].name, 'a');
		assert.strictEqual(rows[1].name, 'b');
		assert.strictEqual(rows[2].name, 'c');
	});

	it('should handle COUNT and other aggregate functions', async () => {
		await db.exec("INSERT INTO test_table (name, value) VALUES ('item1', 100)");
		await db.exec("INSERT INTO test_table (name, value) VALUES ('item2', 200)");
		await db.exec("INSERT INTO test_table (name, value) VALUES ('item3', 300)");

		const stmt = await db.prepare("SELECT COUNT(*) as count, SUM(value) as sum, AVG(value) as avg FROM test_table");
		const result = await stmt.step();

		assert.strictEqual(result, StatusCode.ROW);
		const row = stmt.getAsObject();
		assert.strictEqual(row.count, 3);
		assert.strictEqual(row.sum, 600);
		assert.strictEqual(row.avg, 200);

		await stmt.finalize();
	});
});
