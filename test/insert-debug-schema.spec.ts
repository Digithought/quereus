import { expect } from "chai";
import { Database } from "../src/index.js";

describe(`INSERT Schema Debug`, () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('should examine table schema and primary key definition', async () => {
		try {
			console.log('Creating table...');
			await db.exec('CREATE TABLE insert_test (id INTEGER, name TEXT);');

			// Access the table schema through the database's schema manager
			const schemaManager = (db as any).schemaManager;
			const tableSchema = schemaManager.findTable('insert_test', 'main');

			console.log('Table schema:', {
				name: tableSchema?.name,
				columns: tableSchema?.columns,
				primaryKeyDefinition: tableSchema?.primaryKeyDefinition,
				vtabModuleName: tableSchema?.vtabModuleName
			});

			if (tableSchema?.primaryKeyDefinition) {
				console.log('Primary key definition length:', tableSchema.primaryKeyDefinition.length);
				tableSchema.primaryKeyDefinition.forEach((pkDef: any, i: number) => {
					console.log(`PK column ${i}:`, {
						index: pkDef.index,
						desc: pkDef.desc,
						collation: pkDef.collation
					});
				});
			} else {
				console.log('No primary key definition found!');
			}

		} catch (error) {
			console.error('Schema examination failed:', error);
			throw error;
		}
	});
});
