/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { Database } from "../src/index.js";
import { MemoryTableModule } from "../src/vtab/memory/module.js";
import { MemoryTable } from "../src/vtab/memory/table.js";
import type { TableSchema, IndexSchema } from "../src/schema/table.js";
import type { ColumnSchema } from "../src/schema/column.js";
import type { FilterInfo } from "../src/vtab/filter-info.js";
import type { IndexInfo } from "../src/vtab/index-info.js";
import { StatusCode, SqlDataType } from "../src/common/types.js";
import { IndexConstraintOp, ConflictResolution } from "../src/common/constants.js";
import type * as AST from "../src/parser/ast.js";
import { INTEGER_TYPE, TEXT_TYPE, REAL_TYPE, BLOB_TYPE } from "../src/types/index.js";

describe("Memory VTable Module", () => {
	let db: Database;
	let module: MemoryTableModule;

	beforeEach(() => {
		db = new Database();
		module = new MemoryTableModule();
	});

	afterEach(async () => {
		await db.close();
	});

	// Helper function to create a basic table schema
	function createTableSchema(
		name: string = 'test_table',
		columns: ColumnSchema[] = [
			{ name: 'id', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
			{ name: 'name', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
			{ name: 'value', logicalType: REAL_TYPE, affinity: SqlDataType.REAL, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
		],
		primaryKey: string[] = ['id']
	): TableSchema {
		const columnIndexMap = new Map(columns.map((col, idx) => [col.name, idx]));
		const primaryKeyDefinition = primaryKey.map(pkCol => {
			const index = columnIndexMap.get(pkCol);
			if (index === undefined) throw new Error(`PK column ${pkCol} not found`);
			return { index, desc: false };
		});

		return {
			vtabModuleName: 'memory',
			schemaName: 'main',
			name,
			columns: Object.freeze(columns),
			columnIndexMap,
			primaryKeyDefinition: Object.freeze(primaryKeyDefinition),
			indexes: Object.freeze([]),
			checkConstraints: Object.freeze([]),
			vtabModule: module,
			isTemporary: false,
			isView: false
		};
	}

	// Helper to create basic filter info for full table scan
	function createFilterInfo(_constraints: any[] = [], _orderBy: any[] = []): FilterInfo {
		return {
			idxNum: 0,
			idxStr: 'full_scan',
			constraints: [],
			args: [],
			indexInfoOutput: {
				nConstraint: 0,
				aConstraint: [],
				nOrderBy: 0,
				aOrderBy: [],
				colUsed: 0n,
				aConstraintUsage: [],
				idxNum: 0,
				idxStr: '',
				orderByConsumed: false,
				estimatedCost: 0,
				estimatedRows: BigInt(0),
				idxFlags: 0
			}
		};
	}

	describe("Module Creation and Connection", () => {
		it("should create a new memory table", async () => {
			const schema = createTableSchema('users');
			const table = module.create(db, schema);

			expect(table).to.be.instanceOf(MemoryTable);
			expect(table.tableName).to.equal('users');
			expect(table.schemaName).to.equal('main');
		});

		it("should connect to an existing memory table", async () => {
			const schema = createTableSchema('users');
			module.create(db, schema);

			const table2 = module.connect(db, null, 'memory', 'main', 'users', {});
			expect(table2).to.be.instanceOf(MemoryTable);
			expect(table2.tableName).to.equal('users');
		});

		it("should fail to connect to non-existent table", async () => {
			try {
				module.connect(db, null, 'memory', 'main', 'nonexistent', {});
				expect.fail("Should have thrown error");
			} catch (error: any) {
				expect(error.message).to.include('not found');
			}
		});
	});

	describe("Basic CRUD Operations via query and update", () => {
		let table: MemoryTable;
		let schema: TableSchema;

		beforeEach(async () => {
			schema = createTableSchema('products', [
				{ name: 'id', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'price', logicalType: REAL_TYPE, affinity: SqlDataType.REAL, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'category', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = module.create(db, schema);
		});

		it("should insert data via update", async () => {
			const newRow = [1, 'Laptop', 999.99, 'Electronics'];
			const result = await table.update('insert', newRow);

			expect(result).to.deep.equal(newRow);
		});

		it("should query data via query", async () => {
			// Insert test data
			await table.update('insert', [1, 'Laptop', 999.99, 'Electronics']);
			await table.update('insert', [2, 'Mouse', 29.99, 'Electronics']);

			// Query all data
			const rows = [];
			const filterInfo = createFilterInfo();
			for await (const row of table.query(filterInfo)) {
				rows.push(row);
			}

			expect(rows).to.have.length(2);
			expect(rows[0]).to.deep.equal([1, 'Laptop', 999.99, 'Electronics']);
			expect(rows[1]).to.deep.equal([2, 'Mouse', 29.99, 'Electronics']);
		});

		it("should update existing data via update", async () => {
			await table.update('insert', [1, 'Laptop', 999.99, 'Electronics']);

			// Update the row
			const updatedRow = [1, 'Gaming Laptop', 1199.99, 'Electronics'];
			const oldKeyValues = [1]; // Primary key values
			const result = await table.update('update', updatedRow, oldKeyValues);

			expect(result).to.deep.equal(updatedRow);

			// Verify the update
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(1);
			expect(rows[0][1]).to.equal('Gaming Laptop');
			expect(rows[0][2]).to.equal(1199.99);
		});

		it("should delete data via update", async () => {
			await table.update('insert', [1, 'Laptop', 999.99, 'Electronics']);
			await table.update('insert', [2, 'Mouse', 29.99, 'Electronics']);

			// Delete first row
			const oldKeyValues = [1];
			const result = await table.update('delete', undefined, oldKeyValues);

			expect(result).to.deep.equal([1, 'Laptop', 999.99, 'Electronics']);

			// Verify deletion
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(1);
			expect(rows[0][0]).to.equal(2);
		});

		it("should handle update with primary key change", async () => {
			await table.update('insert', [1, 'Laptop', 999.99, 'Electronics']);

			// Update with new primary key
			const updatedRow = [10, 'Laptop', 999.99, 'Electronics'];
			const oldKeyValues = [1];
			const result = await table.update('update', updatedRow, oldKeyValues);

			expect(result).to.deep.equal(updatedRow);

			// Verify old key is gone and new key exists
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(1);
			expect(rows[0][0]).to.equal(10);
		});
	});

	describe("Constraint Handling", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('users', [
				{ name: 'id', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'email', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = module.create(db, schema);
		});

		it("should enforce primary key uniqueness", async () => {
			await table.update('insert', [1, 'user@example.com']);

			try {
				await table.update('insert', [1, 'other@example.com']);
				expect.fail("Should have thrown constraint error");
			} catch (error: any) {
				expect(error.message).to.include('UNIQUE constraint failed');
			}
		});

		it("should handle conflict resolution with INSERT OR IGNORE", async () => {
			await table.update('insert', [1, 'user@example.com']);

			// Simulate INSERT OR IGNORE by passing conflict resolution
			const rowWithConflictRes = [1, 'other@example.com'];
			const result = await table.update('insert', rowWithConflictRes, undefined, ConflictResolution.IGNORE);
			void expect(result).to.be.undefined; // IGNORE should return undefined

			// Verify original data unchanged
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			void expect(rows).to.have.length(1);
			void expect(rows[0][1]).to.equal('user@example.com');
		});
	});

	describe("Composite Primary Keys", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('user_sessions', [
				{ name: 'user_id', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'session_id', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'created_at', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['user_id', 'session_id']);
			table = module.create(db, schema);
		});

		it("should handle composite primary key operations", async () => {
			await table.update('insert', [1, 'sess_123', '2024-01-01']);
			await table.update('insert', [1, 'sess_456', '2024-01-02']);
			await table.update('insert', [2, 'sess_123', '2024-01-01']);

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(3);
		});

		it("should enforce composite primary key uniqueness", async () => {
			await table.update('insert', [1, 'sess_123', '2024-01-01']);

			try {
				await table.update('insert', [1, 'sess_123', '2024-01-02']);
				expect.fail("Should have thrown constraint error");
			} catch (error: any) {
				expect(error.message).to.include('UNIQUE constraint failed');
			}
		});

		it("should update with composite primary key", async () => {
			await table.update('insert', [1, 'sess_123', '2024-01-01']);

			const updatedRow = [1, 'sess_123', '2024-01-01-updated'];
			const oldKeyValues = [1, 'sess_123'];
			const result = await table.update('update', updatedRow, oldKeyValues);

			expect(result).to.deep.equal(updatedRow);
		});

		it("should delete with composite primary key", async () => {
			await table.update('insert', [1, 'sess_123', '2024-01-01']);
			await table.update('insert', [1, 'sess_456', '2024-01-02']);

			const oldKeyValues = [1, 'sess_123'];
			const result = await table.update('delete', undefined, oldKeyValues);

			expect(result).to.deep.equal([1, 'sess_123', '2024-01-01']);

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(1);
			expect(rows[0][1]).to.equal('sess_456');
		});
	});

	describe("Secondary Indexes", () => {
		let table: MemoryTable;
		let schema: TableSchema;

		beforeEach(async () => {
			schema = createTableSchema('employees', [
				{ name: 'id', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'department', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'salary', logicalType: REAL_TYPE, affinity: SqlDataType.REAL, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = module.create(db, schema);
		});

		it("should create secondary indexes", async () => {
			const deptIndex: IndexSchema = {
				name: 'idx_department',
				columns: [{ index: 2, desc: false }]
			};

			await table.createIndex(deptIndex);

			// Verify the index is in the schema
			const currentSchema = table.getSchema();
			expect(currentSchema?.indexes).to.have.length(1);
			expect(currentSchema?.indexes?.[0].name).to.equal('idx_department');
		});

		it("should create composite indexes", async () => {
			const compositeIndex: IndexSchema = {
				name: 'idx_dept_salary',
				columns: [
					{ index: 2, desc: false },
					{ index: 3, desc: true }
				]
			};

			await table.createIndex(compositeIndex);

			const currentSchema = table.getSchema();
			expect(currentSchema?.indexes).to.have.length(1);
			expect(currentSchema?.indexes?.[0].columns).to.have.length(2);
		});

		it("should drop indexes", async () => {
			const deptIndex: IndexSchema = {
				name: 'idx_department',
				columns: [{ index: 2, desc: false }]
			};

			await table.createIndex(deptIndex);
			await table.dropIndex('idx_department');

			const currentSchema = table.getSchema();
			expect(currentSchema?.indexes).to.have.length(0);
		});
	});

	describe("Transaction Support", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('accounts', [
				{ name: 'id', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'balance', logicalType: REAL_TYPE, affinity: SqlDataType.REAL, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = module.create(db, schema);

			// Insert initial data
			await table.update('insert', [1, 1000.0]);
			await table.update('insert', [2, 500.0]);
		});

		it("should handle basic transactions", async () => {
			await table.begin();
			await table.update('update', [1, 900.0], [1]);
			await table.update('update', [2, 600.0], [2]);
			await table.commit();

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows.find(r => r[0] === 1)?.[1]).to.equal(900.0);
			expect(rows.find(r => r[0] === 2)?.[1]).to.equal(600.0);
		});

		it("should rollback transactions", async () => {
			await table.begin();
			await table.update('update', [1, 0.0], [1]);
			await table.rollback();

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows.find(r => r[0] === 1)?.[1]).to.equal(1000.0);
		});

		it("should handle savepoints", async () => {
			await table.begin();
			await table.update('update', [1, 950.0], [1]);
			await table.savepoint(1);
			await table.update('update', [1, 850.0], [1]);
			await table.rollbackTo(1);
			await table.commit();

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows.find(r => r[0] === 1)?.[1]).to.equal(950.0);
		});

		it("should release savepoints", async () => {
			await table.begin();
			await table.update('update', [1, 950.0], [1]);
			await table.savepoint(1);
			await table.update('update', [1, 850.0], [1]);
			await table.release(1);
			await table.commit();

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows.find(r => r[0] === 1)?.[1]).to.equal(850.0);
		});
	});

	describe("Schema Changes via alterSchema", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('test_table', [
				{ name: 'id', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = module.create(db, schema);
			await table.update('insert', [1, 'test']);
		});

		it("should add columns", async () => {
			const columnDef = {
				name: 'age',
				dataType: 'INTEGER',
				constraints: [
					{ type: 'default' as const, expr: { type: 'literal' as const, value: 0 } }
				]
			};

			await table.alterSchema({ type: 'addColumn', columnDef });

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows[0]).to.have.length(3);
			expect(rows[0][2]).to.equal(0); // Default value
		});

		it("should drop columns", async () => {
			// First add a column to drop
			const columnDef: AST.ColumnDef = {
				name: 'temp_col',
				dataType: 'TEXT',
				constraints: [{ type: 'null' as const }]
			};

			await table.alterSchema({ type: 'addColumn', columnDef });
			await table.alterSchema({ type: 'dropColumn', columnName: 'temp_col' });

			const schema = table.getSchema();
			void expect(schema?.columns).to.have.length(2);
			void expect(schema?.columns.find(c => c.name === 'temp_col')).to.be.undefined;
		});

		it("should rename columns", async () => {
			await table.alterSchema({
				type: 'renameColumn',
				oldName: 'name',
				newName: 'full_name',
				newColumnDefAst: {
					name: 'full_name',
					dataType: 'TEXT',
					constraints: []
				}
			});

			const schema = table.getSchema();
			void expect(schema?.columns.find(c => c.name === 'full_name')).to.exist;
			void expect(schema?.columns.find(c => c.name === 'name')).to.be.undefined;
		});

		it("should prevent dropping primary key columns", async () => {
			try {
				await table.alterSchema({ type: 'dropColumn', columnName: 'id' });
				void expect.fail("Should not allow dropping PK column");
			} catch (error: any) {
				void expect(error.message).to.include('Cannot drop PK column');
			}
		});
	});

	describe("Data Types and Edge Cases", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('mixed_types', [
				{ name: 'id', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'text_col', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'real_col', logicalType: REAL_TYPE, affinity: SqlDataType.REAL, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'blob_col', logicalType: BLOB_TYPE, affinity: SqlDataType.BLOB, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'null_col', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = module.create(db, schema);
		});

		it("should handle various data types", async () => {
			const blobData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
			await table.update('insert', [1, 'hello', 3.14, blobData, null]);
			await table.update('insert', [2, '', 0.0, new Uint8Array(0), 'not null']);

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			void expect(rows).to.have.length(2);
			void expect(rows[0][1]).to.equal('hello');
			void expect(rows[0][2]).to.equal(3.14);
			void expect(rows[0][3]).to.deep.equal(blobData);
			void expect(rows[0][4]).to.be.null;
			void expect(rows[1][4]).to.equal('not null');
		});

		it("should handle NULL in composite primary keys", async () => {
			const schema = createTableSchema('composite_null', [
				{ name: 'part1', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'part2', logicalType: INTEGER_TYPE, affinity: SqlDataType.INTEGER, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'value', logicalType: TEXT_TYPE, affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['part1', 'part2']);
			const table2 = module.create(db, schema);

			await table2.update('insert', ['a', 1, 'value1']);
			await table2.update('insert', [null, 2, 'value2']);

			const rows = [];
			for await (const row of table2.query(createFilterInfo())) {
				rows.push(row);
			}

			void expect(rows).to.have.length(2);
			void expect(rows[0][0]).to.be.null;
			void expect(rows[1][0]).to.equal('a');
		});

		it("should handle empty table operations", async () => {
			// Operations on empty table should not error
			await table.update('update', [999, 'new'], [999]);
			await table.update('delete', undefined, [999]);

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}
			void expect(rows).to.have.length(0);
		});
	});

	describe("Read-Only Tables", () => {
		it("should create read-only tables", async () => {
			const schema: TableSchema = {
				...createTableSchema('readonly_data'),
				isReadOnly: true
			};
			const table = module.create(db, schema);

			void expect(table.isReadOnly()).to.be.true;

			// Should be able to query empty table
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}
			void expect(rows).to.have.length(0);
		});

		it("should prevent modifications to read-only tables", async () => {
			const schema: TableSchema = {
				...createTableSchema('readonly_data'),
				isReadOnly: true
			};
			const table = module.create(db, schema);

			try {
				await table.update('insert', [1, 'test']);
				expect.fail("Should not allow INSERT on read-only table");
			} catch (error: any) {
				expect(error.message).to.include('read-only');
			}
		});
	});

	describe("Module Cleanup", () => {
		it("should destroy tables and clean up resources", async () => {
			const schema = createTableSchema('temp_table');
			module.create(db, schema);

			await module.destroy(db, null, 'memory', 'main', 'temp_table');

			// Should not be able to connect to destroyed table
			try {
				module.connect(db, null, 'memory', 'main', 'temp_table', {});
				expect.fail("Should not be able to connect to destroyed table");
			} catch (error: any) {
				expect(error.message).to.include('not found');
			}
		});
	});
});
