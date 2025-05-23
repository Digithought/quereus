import { expect } from "chai";
import { Database } from "../src/index.js";

describe(`CREATE TABLE Debug`, () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('should handle basic CREATE TABLE', async () => {
		try {
			console.log('Attempting to create table...');
			await db.exec('CREATE TABLE simple_test (id INTEGER, name TEXT);');
			console.log('Table created successfully!');

			// Verify the table exists by checking schema
			const resultRows: any[] = [];
			for await (const row of db.eval("SELECT * FROM _schema WHERE name = 'simple_test' AND type = 'table';")) {
				resultRows.push(row);
				break; // Just get first row
			}

			console.log('Schema query result:', resultRows);
			expect(resultRows).to.have.length(1);
			expect(resultRows[0]).to.have.property('name', 'simple_test');
			expect(resultRows[0]).to.have.property('type', 'table');

		} catch (error) {
			console.error('CREATE TABLE failed:', error);
			throw error;
		}
	});

	it('should handle CREATE TABLE with multiple data types', async () => {
		try {
			console.log('Creating table with multiple data types...');
			await db.exec('CREATE TABLE multi_type (id INTEGER, name TEXT, amount REAL, data BLOB, flag BOOLEAN);');
			console.log('Multi-type table created successfully!');

			// Basic verification
			const resultRows: any[] = [];
			for await (const row of db.eval("SELECT * FROM _schema WHERE name = 'multi_type' AND type = 'table';")) {
				resultRows.push(row);
				break;
			}

			expect(resultRows).to.have.length(1);

		} catch (error) {
			console.error('Multi-type CREATE TABLE failed:', error);
			throw error;
		}
	});
});
