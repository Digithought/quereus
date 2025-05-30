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
		expect(resultRows.length).to.be.greaterThan(0);
		const schemaEntry = resultRows.find(r => r.name === 'upper' && r.type === 'function');
		expect(schemaEntry).to.exist;
	});

	it('should create a simple table', async () => {
		await db.exec('create table t (a text, b integer);');

		const resultRows: Record<string, any>[] = [];
		for await (const row of db.eval(`select * from schema()`)) {
			resultRows.push(row);
		}
		expect(resultRows.length).to.be.greaterThan(0);
		const schemaEntry = resultRows.find(r => r.name === 't' && r.type === 'table');
		expect(schemaEntry).to.exist;
	});
});
