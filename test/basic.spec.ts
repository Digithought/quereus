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
		for await (const row of db.eval(`select * from _schema`)) {
			resultRows.push(row);
		}
		// Update expectations based on what _schema actually returns.
		// For example, it might return more than one row.
		// This is a placeholder assertion.
		expect(resultRows.length).to.be.greaterThan(0);
		const schemaEntry = resultRows.find(r => r.name === 'upper' && r.type === 'function');
		expect(schemaEntry).to.exist;
	});
});
