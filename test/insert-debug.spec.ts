import { expect } from "chai";
import { Database } from "../src/index.js";

describe(`INSERT Debug`, () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// First create a table to insert into
		await db.exec('CREATE TABLE insert_test (id INTEGER, name TEXT);');
	});

	afterEach(async () => {
		await db.close();
	});

	it('should handle basic INSERT with VALUES', async () => {
		try {
			console.log('Attempting basic INSERT...');
			await db.exec("INSERT INTO insert_test VALUES (1, 'Alice');");
			console.log('INSERT completed successfully!');

			// Verify the data was inserted
			const resultRows: any[] = [];
			for await (const row of db.eval('SELECT * FROM insert_test;')) {
				resultRows.push(row);
			}

			console.log('SELECT result:', resultRows);
			expect(resultRows).to.have.length(1);
			expect(resultRows[0]).to.deep.equal({ id: 1, name: 'Alice' });

		} catch (error) {
			console.error('INSERT failed:', error);
			throw error;
		}
	});

	it('should handle INSERT with multiple rows', async () => {
		try {
			console.log('Attempting multi-row INSERT...');
			await db.exec("INSERT INTO insert_test VALUES (1, 'Alice'), (2, 'Bob');");
			console.log('Multi-row INSERT completed successfully!');

			// Verify the data was inserted
			const resultRows: any[] = [];
			for await (const row of db.eval('SELECT * FROM insert_test;')) {
				resultRows.push(row);
			}

			console.log('SELECT result:', resultRows);
			expect(resultRows).to.have.length(2);
			expect(resultRows[0]).to.deep.equal({ id: 1, name: 'Alice' });
			expect(resultRows[1]).to.deep.equal({ id: 2, name: 'Bob' });

		} catch (error) {
			console.error('Multi-row INSERT failed:', error);
			throw error;
		}
	});

	it('should handle INSERT with explicit column specification', async () => {
		try {
			console.log('Attempting INSERT with explicit columns...');
			await db.exec("INSERT INTO insert_test (name, id) VALUES ('Charlie', 3);");
			console.log('Explicit column INSERT completed successfully!');

			// Verify the data was inserted
			const resultRows: any[] = [];
			for await (const row of db.eval('SELECT * FROM insert_test;')) {
				resultRows.push(row);
			}

			console.log('SELECT result:', resultRows);
			expect(resultRows).to.have.length(1);
			expect(resultRows[0]).to.deep.equal({ id: 3, name: 'Charlie' });

		} catch (error) {
			console.error('Explicit column INSERT failed:', error);
			throw error;
		}
	});
});
