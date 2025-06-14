import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';

describe('Default Column Nullability (Third Manifesto)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('Default behavior (NOT NULL)', () => {
		it('should default to NOT NULL columns by default', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					email TEXT
				)
			`);

			// Try to insert NULL values - should fail
			try {
				await db.exec("INSERT INTO users (id, name, email) VALUES (1, NULL, 'test@example.com')");
				expect.fail('Expected NOT NULL constraint to fail');
			} catch (error: any) {
				expect(error).to.be.instanceOf(QuereusError);
				expect(error.code).to.equal(StatusCode.CONSTRAINT);
				expect(error.message).to.include('NOT NULL');
			}

			try {
				await db.exec("INSERT INTO users (id, name, email) VALUES (2, 'John', NULL)");
				expect.fail('Expected NOT NULL constraint to fail');
			} catch (error: any) {
				expect(error).to.be.instanceOf(QuereusError);
				expect(error.code).to.equal(StatusCode.CONSTRAINT);
				expect(error.message).to.include('NOT NULL');
			}

			// Valid insert should work
			await db.exec("INSERT INTO users (id, name, email) VALUES (3, 'Alice', 'alice@example.com')");
			const rows: any[] = [];
			for await (const row of db.prepare("SELECT * FROM users").all()) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0]).to.deep.equal({ id: 3, name: 'Alice', email: 'alice@example.com' });
		});

		it('should verify current default setting', async () => {
			const result = await db.prepare("PRAGMA default_column_nullability").get();
			expect(result).to.have.property('default_column_nullability', 'not_null');
		});

		it('should allow explicit NOT NULL declaration (redundant but allowed)', async () => {
			await db.exec(`
				CREATE TABLE explicit_test (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT
				)
			`);

			// Both should fail with NOT NULL constraint
			try {
				await db.exec("INSERT INTO explicit_test (id, name, email) VALUES (1, NULL, 'test@example.com')");
				expect.fail('Expected NOT NULL constraint to fail');
			} catch (error: any) {
				expect(error.message).to.include('NOT NULL');
			}

			try {
				await db.exec("INSERT INTO explicit_test (id, name, email) VALUES (2, 'John', NULL)");
				expect.fail('Expected NOT NULL constraint to fail');
			} catch (error: any) {
				expect(error.message).to.include('NOT NULL');
			}
		});
	});

	describe('SQL Standard compatibility mode', () => {
		beforeEach(async () => {
			// Switch to SQL standard behavior
			await db.exec("PRAGMA default_column_nullability = 'nullable'");
		});

		it('should allow NULL values when set to nullable mode', async () => {
			await db.exec(`
				CREATE TABLE nullable_users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					email TEXT
				)
			`);

			// These should now succeed
			await db.exec("INSERT INTO nullable_users (id, name, email) VALUES (1, NULL, 'test@example.com')");
			await db.exec("INSERT INTO nullable_users (id, name, email) VALUES (2, 'John', NULL)");
			await db.exec("INSERT INTO nullable_users (id, name, email) VALUES (3, NULL, NULL)");

			const rows = await db.prepare("SELECT * FROM nullable_users ORDER BY id").all();
			expect(rows).to.have.length(3);
			expect(rows[0]).to.deep.equal({ id: 1, name: null, email: 'test@example.com' });
			expect(rows[1]).to.deep.equal({ id: 2, name: 'John', email: null });
			expect(rows[2]).to.deep.equal({ id: 3, name: null, email: null });
		});

		it('should still enforce explicit NOT NULL constraints', async () => {
			await db.exec(`
				CREATE TABLE mixed_nullability (
					id INTEGER PRIMARY KEY,
					name TEXT,
					email TEXT NOT NULL,
					bio TEXT
				)
			`);

			// name and bio can be NULL, email cannot
			await db.exec("INSERT INTO mixed_nullability (id, name, email, bio) VALUES (1, NULL, 'test@example.com', NULL)");

			try {
				await db.exec("INSERT INTO mixed_nullability (id, name, email, bio) VALUES (2, 'John', NULL, 'some bio')");
				expect.fail('Expected NOT NULL constraint to fail on email');
			} catch (error: any) {
				expect(error.message).to.include('NOT NULL');
			}
		});

		it('should verify nullable setting', async () => {
			const result = await db.prepare("PRAGMA default_column_nullability").get();
			expect(result).to.have.property('default_column_nullability', 'nullable');
		});
	});

	describe('Primary key behavior', () => {
		it('should always enforce NOT NULL on primary key columns regardless of setting', async () => {
			// Test with both settings
			for (const setting of ['not_null', 'nullable']) {
				await db.exec(`PRAGMA default_column_nullability = '${setting}'`);
				
				await db.exec(`
					CREATE TABLE pk_test_${setting} (
						id INTEGER PRIMARY KEY,
						name TEXT
					)
				`);

				// Primary key should never allow NULL
				try {
					await db.exec(`INSERT INTO pk_test_${setting} (id, name) VALUES (NULL, 'test')`);
					expect.fail('Expected PRIMARY KEY to reject NULL');
				} catch (error: any) {
					expect(error.message).to.include('NOT NULL');
				}
			}
		});
	});

	describe('ALTER TABLE operations', () => {
		it('should respect current nullability setting when adding columns', async () => {
			await db.exec(`
				CREATE TABLE alter_test (
					id INTEGER PRIMARY KEY,
					name TEXT
				)
			`);

			// Insert a row first
			await db.exec("INSERT INTO alter_test (id, name) VALUES (1, 'test')");

			// Adding a column with default NOT NULL setting should require a DEFAULT value
			try {
				await db.exec("ALTER TABLE alter_test ADD COLUMN email TEXT");
				expect.fail('Expected error when adding NOT NULL column without default');
			} catch (error: any) {
				expect(error.message).to.include('without DEFAULT');
			}

			// Adding with DEFAULT should work
			await db.exec("ALTER TABLE alter_test ADD COLUMN email TEXT DEFAULT 'unknown@example.com'");

			// Switch to nullable mode
			await db.exec("PRAGMA default_column_nullability = 'nullable'");

			// Now adding columns without DEFAULT should work
			await db.exec("ALTER TABLE alter_test ADD COLUMN bio TEXT");

			const rows = await db.prepare("SELECT * FROM alter_test").all();
			expect(rows[0]).to.have.property('email', 'unknown@example.com');
			expect(rows[0]).to.have.property('bio', null);
		});
	});

	describe('Error handling', () => {
		it('should reject invalid pragma values', async () => {
			try {
				await db.exec("PRAGMA default_column_nullability = 'invalid'");
				expect.fail('Expected error for invalid pragma value');
			} catch (error: any) {
				expect(error.message).to.include('Invalid default_column_nullability value');
			}
		});
	});

	describe('Aliases', () => {
		it('should support pragma aliases', async () => {
			// Test aliases
			await db.exec("PRAGMA column_nullability_default = 'nullable'");
			let result = await db.prepare("PRAGMA default_column_nullability").get();
			expect(result).to.have.property('default_column_nullability', 'nullable');

			await db.exec("PRAGMA nullable_default = 'not_null'");
			result = await db.prepare("PRAGMA default_column_nullability").get();
			expect(result).to.have.property('default_column_nullability', 'not_null');
		});
	});
});