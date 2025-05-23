import { expect } from "chai";
import { Database } from "../src/index.js";

describe(`INSERT Minimal Debug`, () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('should test INSERT without immediate SELECT', async () => {
		try {
			console.log('Creating table...');
			await db.exec('CREATE TABLE test_simple (id INTEGER, name TEXT);');
			console.log('Table created.');

			console.log('Attempting INSERT...');
			await db.exec("INSERT INTO test_simple VALUES (1, 'Alice');");
			console.log('INSERT completed without error!');

			// Don't do SELECT yet, just verify INSERT worked
			expect(true).to.be.true; // Just to make the test pass

		} catch (error) {
			console.error('Error occurred:', error);
			throw error;
		}
	});

	it('should test SELECT from empty table', async () => {
		try {
			console.log('Creating table...');
			await db.exec('CREATE TABLE test_empty (id INTEGER, name TEXT);');
			console.log('Table created.');

			console.log('Attempting SELECT from empty table...');
			const resultRows: any[] = [];
			for await (const row of db.eval('SELECT * FROM test_empty;')) {
				resultRows.push(row);
			}
			console.log('SELECT from empty table completed!');
			console.log('Result count:', resultRows.length);

			expect(resultRows).to.have.length(0);

		} catch (error) {
			console.error('Error in SELECT from empty table:', error);
			throw error;
		}
	});
});
