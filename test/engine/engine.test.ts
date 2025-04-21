import { Database } from '../../src/core/database';
import { Parser } from '../../src/parser/parser';
import { Compiler } from '../../src/compiler/compiler';
import { Vdbe } from '../../src/vdbe/engine';
import { StatusCode } from '../../src/common/types';
import { Statement } from '../../src/core/statement';
import { MemoryTableModule } from '../../src/vtab/memory-table';
import { assert } from 'chai';

describe('VDBE Engine', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		const memoryModule = new MemoryTableModule();
		db.registerVtabModule('memory', memoryModule);

		// Create and populate a test table
		await db.exec(`
      CREATE VIRTUAL TABLE test_table USING memory(
        id INTEGER PRIMARY KEY,
        name TEXT,
        age INTEGER
      )
    `);

		await db.exec(`
      INSERT INTO test_table (id, name, age) VALUES
      (1, 'Alice', 30),
      (2, 'Bob', 25),
      (3, 'Charlie', 35),
      (4, 'David', 40),
      (5, 'Eve', 22)
    `);
	});

	afterEach(async () => {
		await db.close();
	});

	describe('Basic execution', () => {
		it('should execute a simple SELECT query', async () => {
			const stmt = await db.prepare('SELECT id, name FROM test_table WHERE id = 3');

			// First step should return a row
			const result = await stmt.step();
			assert.equal(result, StatusCode.ROW);

			// Check the row data
			const row = stmt.getAsObject();
			assert.equal(row.id, 3);
			assert.equal(row.name, 'Charlie');

			// Next step should be done
			const next = await stmt.step();
			assert.equal(next, StatusCode.DONE);

			await stmt.finalize();
		});

		it('should handle multiple rows', async () => {
			const stmt = await db.prepare('SELECT name FROM test_table WHERE age > 25 ORDER BY name');

			const names: string[] = [];
			let result = await stmt.step();
			while (result === StatusCode.ROW) {
				names.push(stmt.getAsObject().name as string);
				result = await stmt.step();
			}

			assert.equal(result, StatusCode.DONE);
			assert.deepEqual(names, ['Alice', 'Charlie', 'David']);

			await stmt.finalize();
		});

		it('should handle parameters', async () => {
			const stmt = await db.prepare('SELECT name FROM test_table WHERE age > ?');
			stmt.bind(1, 30);

			const names: string[] = [];
			let result = await stmt.step();
			while (result === StatusCode.ROW) {
				names.push(stmt.getAsObject().name as string);
				result = await stmt.step();
			}

			assert.equal(result, StatusCode.DONE);
			assert.deepEqual(names, ['Charlie', 'David']);

			await stmt.finalize();
		});

		it('should handle multiple parameter types', async () => {
			const stmt = await db.prepare('SELECT * FROM test_table WHERE name = ? OR age = ?');
			stmt.bind(1, 'Alice');
			stmt.bind(2, 25);

			const rows: any[] = [];
			let result = await stmt.step();
			while (result === StatusCode.ROW) {
				rows.push(stmt.getAsObject());
				result = await stmt.step();
			}

			assert.equal(result, StatusCode.DONE);
			assert.equal(rows.length, 2);

			// Sort by id to ensure consistent order
			rows.sort((a, b) => a.id - b.id);

			assert.equal(rows[0].name, 'Alice');
			assert.equal(rows[1].name, 'Bob');

			await stmt.finalize();
		});
	});

	describe('Arithmetic operations', () => {
		it('should execute arithmetic expressions', async () => {
			const stmt = await db.prepare('SELECT age + 10 AS increased_age FROM test_table WHERE id = 1');

			const result = await stmt.step();
			assert.equal(result, StatusCode.ROW);

			const row = stmt.getAsObject();
			assert.equal(row.increased_age, 40);

			await stmt.finalize();
		});

		it('should handle complex expressions', async () => {
			const stmt = await db.prepare(`
        SELECT id, name,
               CASE
                 WHEN age < 30 THEN 'Young'
                 WHEN age < 40 THEN 'Adult'
                 ELSE 'Senior'
               END AS age_group
        FROM test_table
        WHERE id IN (1, 3, 5)
      `);

			const rows: any[] = [];
			let result = await stmt.step();
			while (result === StatusCode.ROW) {
				rows.push(stmt.getAsObject());
				result = await stmt.step();
			}

			assert.equal(rows.length, 3);

			// Sort by id to ensure consistent order
			rows.sort((a, b) => a.id - b.id);

			assert.equal(rows[0].name, 'Alice');
			assert.equal(rows[0].age_group, 'Adult');

			assert.equal(rows[1].name, 'Charlie');
			assert.equal(rows[1].age_group, 'Adult');

			assert.equal(rows[2].name, 'Eve');
			assert.equal(rows[2].age_group, 'Young');

			await stmt.finalize();
		});
	});

	describe('Data modification', () => {
		it('should execute INSERT statements', async () => {
			// Insert a new row
			await db.exec(`INSERT INTO test_table (id, name, age) VALUES (6, 'Frank', 45)`);

			// Verify the insertion
			const stmt = await db.prepare('SELECT name, age FROM test_table WHERE id = 6');
			const result = await stmt.step();

			assert.equal(result, StatusCode.ROW);
			const row = stmt.getAsObject();
			assert.equal(row.name, 'Frank');
			assert.equal(row.age, 45);

			await stmt.finalize();
		});

		it('should execute UPDATE statements', async () => {
			// Update an existing row
			await db.exec(`UPDATE test_table SET age = 31 WHERE name = 'Alice'`);

			// Verify the update
			const stmt = await db.prepare('SELECT age FROM test_table WHERE name = ?');
			stmt.bind(1, 'Alice');

			const result = await stmt.step();
			assert.equal(result, StatusCode.ROW);
			assert.equal(stmt.getAsObject().age, 31);

			await stmt.finalize();
		});

		it('should execute DELETE statements', async () => {
			// Delete a row
			await db.exec(`DELETE FROM test_table WHERE name = 'Eve'`);

			// Verify the deletion
			const stmt = await db.prepare('SELECT COUNT(*) as count FROM test_table');
			await stmt.step();
			assert.equal(stmt.getAsObject().count, 4);

			await stmt.finalize();
		});
	});

	describe('Error handling', () => {
		it('should handle constraint violations', async () => {
			// Try to insert a row with a duplicate primary key
			let errorThrown = false;
			try {
				await db.exec(`INSERT INTO test_table (id, name, age) VALUES (1, 'Duplicate', 50)`);
			} catch (e) {
				errorThrown = true;
				assert.include((e as Error).message.toLowerCase(), 'constraint');
			}

			assert.isTrue(errorThrown, 'Should throw constraint violation error');
		});

		it('should handle invalid SQL', async () => {
			let errorThrown = false;
			try {
				await db.exec(`SELEC * FROM test_table`);
			} catch (e) {
				errorThrown = true;
			}

			assert.isTrue(errorThrown, 'Should throw parse error');
		});
	});
});
