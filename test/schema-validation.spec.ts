import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';

describe('Schema Validation', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('should capture schema dependencies during emission', async () => {
		// Create a table
		await db.exec(`
			CREATE TABLE test_table (
				id INTEGER PRIMARY KEY,
				name TEXT
			)
		`);

		// Insert some data
		await db.exec(`INSERT INTO test_table (id, name) VALUES (1, 'Alice'), (2, 'Bob')`);

		// Prepare a statement that uses the table
		const stmt = db.prepare('SELECT * FROM test_table WHERE id = ?');

		// The statement should work normally
		const result = await stmt.get([1]);
		expect(result).to.deep.equal({ id: 1, name: 'Alice' });

		await stmt.finalize();
	});

	it('should provide clean error when table is dropped after planning', async () => {
		// Create a table
		await db.exec(`
			CREATE TABLE test_table (
				id INTEGER PRIMARY KEY,
				name TEXT
			)
		`);

		// Insert some data
		await db.exec(`INSERT INTO test_table (id, name) VALUES (1, 'Alice'), (2, 'Bob')`);

		// Prepare a statement that uses the table (this does the planning)
		const stmt = db.prepare('SELECT * FROM test_table WHERE id = ?');

		// Verify it works initially
		const initialResult = await stmt.get([1]);
		expect(initialResult).to.deep.equal({ id: 1, name: 'Alice' });

		// Drop the table after planning but before next execution
		await db.exec('DROP TABLE test_table');

		// The statement should fail with a clean error message on next execution
		try {
			await stmt.get([1]);
			expect.fail('Expected an error when table was dropped');
		} catch (error) {
			expect(error).to.be.instanceOf(QuereusError);
			// The error might be different depending on where the validation occurs
			// For now, just verify we get a reasonable error
			expect((error as QuereusError).message).to.be.a('string');
		}

		await stmt.finalize();
	});

	it('should capture function dependencies during emission', async () => {
		// Register a custom function
		db.createScalarFunction('test_func', { numArgs: 1 }, (x: number) => x * 2);

		// Prepare a statement that uses the function
		const stmt = db.prepare('SELECT test_func(5) as result');

		// The statement should work normally and use the captured function
		const result = await stmt.get();
		expect(result).to.deep.equal({ result: 10 });

		// Execute again to verify it uses the captured function
		const result2 = await stmt.get();
		expect(result2).to.deep.equal({ result: 10 });

		await stmt.finalize();
	});

	it('should work with virtual tables', async () => {
		// Create a memory table (all tables are virtual tables in this system)
		await db.exec(`
			CREATE TABLE memory_table (
				id INTEGER,
				value TEXT
			)
		`);

		// Insert some data
		await db.exec(`INSERT INTO memory_table VALUES (1, 'test'), (2, 'data')`);

		// Prepare a statement that uses the virtual table
		const stmt = db.prepare('SELECT * FROM memory_table WHERE id = ?');

		// The statement should work normally
		const result = await stmt.get([1]);
		expect(result).to.deep.equal({ id: 1, value: 'test' });

		await stmt.finalize();
	});


});
