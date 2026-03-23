import { describe, it } from 'mocha';
import { Database } from '../src/index.js';
import assert from 'node:assert';

describe('AUTOINCREMENT schema propagation', () => {
	it('should set autoIncrement=true only when AUTOINCREMENT keyword is present', async () => {
		const db = new Database();

		await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY AUTOINCREMENT)');

		const table = db.schemaManager.getTable('main', 't1');
		assert(table, 'Table should exist');
		assert.strictEqual(table.primaryKeyDefinition.length, 1);
		assert.strictEqual(table.primaryKeyDefinition[0].autoIncrement, true,
			'INTEGER PRIMARY KEY AUTOINCREMENT should have autoIncrement=true');
	});

	it('should set autoIncrement=false for INTEGER PRIMARY KEY without AUTOINCREMENT', async () => {
		const db = new Database();

		await db.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY)');

		const table = db.schemaManager.getTable('main', 't2');
		assert(table, 'Table should exist');
		assert.strictEqual(table.primaryKeyDefinition.length, 1);
		assert.strictEqual(table.primaryKeyDefinition[0].autoIncrement, false,
			'INTEGER PRIMARY KEY without AUTOINCREMENT should have autoIncrement=false');
	});

	it('should set autoIncrement=false for non-INTEGER primary keys', async () => {
		const db = new Database();

		await db.exec('CREATE TABLE t3 (name TEXT PRIMARY KEY)');

		const table = db.schemaManager.getTable('main', 't3');
		assert(table, 'Table should exist');
		assert.strictEqual(table.primaryKeyDefinition.length, 1);
		assert.strictEqual(table.primaryKeyDefinition[0].autoIncrement, false,
			'TEXT PRIMARY KEY should have autoIncrement=false');
	});

	it('should not set autoIncrement on table-level PRIMARY KEY constraints', async () => {
		const db = new Database();

		await db.exec('CREATE TABLE t4 (id INTEGER, PRIMARY KEY (id))');

		const table = db.schemaManager.getTable('main', 't4');
		assert(table, 'Table should exist');
		assert.strictEqual(table.primaryKeyDefinition.length, 1);
		// Table-level PK constraints don't support AUTOINCREMENT syntax
		assert.strictEqual(table.primaryKeyDefinition[0].autoIncrement, undefined,
			'Table-level PRIMARY KEY should not have autoIncrement set');
	});

	it('should propagate autoIncrement through ColumnSchema', async () => {
		const db = new Database();

		await db.exec('CREATE TABLE t5 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');

		const table = db.schemaManager.getTable('main', 't5');
		assert(table, 'Table should exist');
		assert.strictEqual(table.columns[0].autoIncrement, true,
			'Column schema should have autoIncrement=true');
		assert.strictEqual(table.columns[1].autoIncrement, undefined,
			'Non-PK column should not have autoIncrement');
	});
});
