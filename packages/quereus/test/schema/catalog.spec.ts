import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { collectSchemaCatalog, generateDeclaredDDL } from '../../src/schema/catalog.js';
import { computeSchemaHash, computeShortSchemaHash } from '../../src/schema/schema-hasher.js';
import type * as AST from '../../src/parser/ast.js';

describe('Schema Catalog', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('collectSchemaCatalog', () => {
		it('should return empty catalog for missing schema', () => {
			const catalog = collectSchemaCatalog(db, 'nonexistent');
			expect(catalog.schemaName).to.equal('nonexistent');
			expect(catalog.tables).to.have.length(0);
			expect(catalog.views).to.have.length(0);
			expect(catalog.indexes).to.have.length(0);
			expect(catalog.assertions).to.have.length(0);
		});

		it('should collect tables from main schema', async () => {
			await db.exec('CREATE TABLE test_t (id INTEGER PRIMARY KEY, name TEXT)');

			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.tables.length).to.be.greaterThanOrEqual(1);

			const table = catalog.tables.find(t => t.name === 'test_t');
			expect(table).to.exist;
			expect(table!.ddl).to.include('test_t');
			expect(table!.columns).to.have.length(2);
			expect(table!.columns[0].name).to.equal('id');
			expect(table!.columns[1].name).to.equal('name');
		});

		it('should collect tables with composite primary keys', async () => {
			await db.exec('CREATE TABLE comp_pk (a INTEGER, b TEXT, c REAL, PRIMARY KEY (a, b))');

			const catalog = collectSchemaCatalog(db, 'main');
			const table = catalog.tables.find(t => t.name === 'comp_pk');
			expect(table).to.exist;
			expect(table!.ddl).to.include('PRIMARY KEY');
		});

		it('should collect indexes', async () => {
			await db.exec('CREATE TABLE idx_t (id INTEGER PRIMARY KEY, name TEXT, category TEXT)');
			await db.exec('CREATE INDEX idx_name ON idx_t (name)');

			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.indexes.length).to.be.greaterThanOrEqual(1);

			const idx = catalog.indexes.find(i => i.name === 'idx_name');
			expect(idx).to.exist;
			expect(idx!.tableName).to.equal('idx_t');
			expect(idx!.ddl).to.include('idx_name');
		});

		it('should collect views', async () => {
			await db.exec('CREATE TABLE v_src (id INTEGER PRIMARY KEY, val TEXT)');
			await db.exec('CREATE VIEW v_test AS SELECT id, val FROM v_src WHERE id > 0');

			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.views.length).to.be.greaterThanOrEqual(1);

			const view = catalog.views.find(v => v.name === 'v_test');
			expect(view).to.exist;
			expect(view!.ddl).to.include('select');
		});

		it('should handle table with no indexes', async () => {
			await db.exec('CREATE TABLE no_idx (id INTEGER PRIMARY KEY, val TEXT)');

			const catalog = collectSchemaCatalog(db, 'main');
			const tableIndexes = catalog.indexes.filter(i => i.tableName === 'no_idx');
			expect(tableIndexes).to.have.length(0);
		});

		it('should default to main schema', async () => {
			await db.exec('CREATE TABLE default_schema (id INTEGER PRIMARY KEY)');

			const catalog = collectSchemaCatalog(db);
			expect(catalog.schemaName).to.equal('main');
			expect(catalog.tables.find(t => t.name === 'default_schema')).to.exist;
		});
	});

	describe('generateDeclaredDDL', () => {
		it('should generate DDL for a declared table', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredTable',
					tableStmt: {
						type: 'createTable',
						table: { type: 'identifier', name: 'users' },
						ifNotExists: false,
						columns: [
							{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
							{ name: 'name', dataType: 'TEXT', constraints: [{ type: 'notNull' }] },
						],
						constraints: [],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(1);
			expect(ddl[0].toLowerCase()).to.include('create table');
			expect(ddl[0]).to.include('users');
		});

		it('should qualify table name with non-main target schema', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'myapp',
				items: [{
					type: 'declaredTable',
					tableStmt: {
						type: 'createTable',
						table: { type: 'identifier', name: 'data' },
						ifNotExists: false,
						columns: [
							{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
						],
						constraints: [],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema, 'myapp');
			expect(ddl).to.have.length(1);
			expect(ddl[0]).to.include('myapp');
		});

		it('should not qualify when target schema is main', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredTable',
					tableStmt: {
						type: 'createTable',
						table: { type: 'identifier', name: 'data' },
						ifNotExists: false,
						columns: [
							{ name: 'id', dataType: 'INTEGER', constraints: [] },
						],
						constraints: [],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema, 'main');
			expect(ddl).to.have.length(1);
			// Should not include schema qualification for 'main'
		});

		it('should generate DDL for declared indexes', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredIndex',
					indexStmt: {
						type: 'createIndex',
						index: { type: 'identifier', name: 'idx_name' },
						table: { type: 'identifier', name: 'users' },
						ifNotExists: false,
						isUnique: false,
						columns: [{ name: 'name' }],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(1);
			expect(ddl[0].toLowerCase()).to.include('create index');
			expect(ddl[0]).to.include('idx_name');
		});

		it('should qualify index table with non-main target schema', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredIndex',
					indexStmt: {
						type: 'createIndex',
						index: { type: 'identifier', name: 'idx_x' },
						table: { type: 'identifier', name: 'data' },
						ifNotExists: false,
						isUnique: false,
						columns: [{ name: 'x' }],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema, 'custom');
			expect(ddl).to.have.length(1);
			expect(ddl[0]).to.include('custom');
		});

		it('should generate DDL for declared views', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredView',
					viewStmt: {
						type: 'createView',
						view: { type: 'identifier', name: 'v_active' },
						ifNotExists: false,
						select: {
							type: 'select',
							columns: [{ type: 'all' }],
							from: { type: 'table', table: { type: 'identifier', name: 'users' } },
						},
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(1);
			expect(ddl[0].toLowerCase()).to.include('create view');
			expect(ddl[0]).to.include('v_active');
		});

		it('should handle empty schema', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'empty',
				items: [],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(0);
		});

		it('should handle mixed items', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [
					{
						type: 'declaredTable',
						tableStmt: {
							type: 'createTable',
							table: { type: 'identifier', name: 't1' },
							ifNotExists: false,
							columns: [{ name: 'id', dataType: 'INTEGER', constraints: [] }],
							constraints: [],
						},
					},
					{
						type: 'declaredIndex',
						indexStmt: {
							type: 'createIndex',
							index: { type: 'identifier', name: 'idx1' },
							table: { type: 'identifier', name: 't1' },
							ifNotExists: false,
							isUnique: false,
							columns: [{ name: 'id' }],
						},
					},
				],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(2);
		});
	});
});

describe('Schema Hasher', () => {
	it('should compute a hash from declared schema', () => {
		const schema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [
						{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
					],
					constraints: [],
				},
			}],
		};

		const hash = computeSchemaHash(schema);
		expect(hash).to.be.a('string');
		expect(hash.length).to.be.greaterThan(0);
	});

	it('should compute identical hash for identical schemas', () => {
		const makeSchema = (): AST.DeclareSchemaStmt => ({
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [
						{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
						{ name: 'name', dataType: 'TEXT', constraints: [] },
					],
					constraints: [],
				},
			}],
		});

		const hash1 = computeSchemaHash(makeSchema());
		const hash2 = computeSchemaHash(makeSchema());
		expect(hash1).to.equal(hash2);
	});

	it('should compute different hash for different schemas', () => {
		const schema1: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [{ name: 'id', dataType: 'INTEGER', constraints: [] }],
					constraints: [],
				},
			}],
		};

		const schema2: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'orders' },
					ifNotExists: false,
					columns: [{ name: 'id', dataType: 'INTEGER', constraints: [] }],
					constraints: [],
				},
			}],
		};

		expect(computeSchemaHash(schema1)).to.not.equal(computeSchemaHash(schema2));
	});

	it('should strip tags before hashing (tags do not affect hash)', () => {
		const baseSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [
						{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
					],
					constraints: [],
				},
			}],
		};

		const taggedSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [
						{
							name: 'id',
							dataType: 'INTEGER',
							constraints: [{ type: 'primaryKey' }],
							tags: { label: 'pk-col' },
						},
					],
					constraints: [],
					tags: { version: '1.0' },
				},
			}],
		};

		expect(computeSchemaHash(baseSchema)).to.equal(computeSchemaHash(taggedSchema));
	});

	it('should strip tags from indexes', () => {
		const noTagSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredIndex',
				indexStmt: {
					type: 'createIndex',
					index: { type: 'identifier', name: 'idx1' },
					table: { type: 'identifier', name: 't1' },
					ifNotExists: false,
					isUnique: false,
					columns: [{ name: 'col1' }],
				},
			}],
		};

		const taggedSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredIndex',
				indexStmt: {
					type: 'createIndex',
					index: { type: 'identifier', name: 'idx1' },
					table: { type: 'identifier', name: 't1' },
					ifNotExists: false,
					isUnique: false,
					columns: [{ name: 'col1' }],
					tags: { note: 'performance' },
				},
			}],
		};

		expect(computeSchemaHash(noTagSchema)).to.equal(computeSchemaHash(taggedSchema));
	});

	it('should strip tags from views', () => {
		const noTagSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredView',
				viewStmt: {
					type: 'createView',
					view: { type: 'identifier', name: 'v1' },
					ifNotExists: false,
					select: {
						type: 'select',
						columns: [{ type: 'all' }],
						from: { type: 'table', table: { type: 'identifier', name: 't1' } },
					},
				},
			}],
		};

		const taggedSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredView',
				viewStmt: {
					type: 'createView',
					view: { type: 'identifier', name: 'v1' },
					ifNotExists: false,
					select: {
						type: 'select',
						columns: [{ type: 'all' }],
						from: { type: 'table', table: { type: 'identifier', name: 't1' } },
					},
					tags: { api: 'v2' },
				},
			}],
		};

		expect(computeSchemaHash(noTagSchema)).to.equal(computeSchemaHash(taggedSchema));
	});

	it('should compute short hash of 8 characters', () => {
		const schema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [{ name: 'id', dataType: 'INTEGER', constraints: [] }],
					constraints: [],
				},
			}],
		};

		const shortHash = computeShortSchemaHash(schema);
		expect(shortHash).to.have.length(8);

		const fullHash = computeSchemaHash(schema);
		expect(fullHash.startsWith(shortHash)).to.be.true;
	});

	it('should handle empty schema', () => {
		const schema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [],
		};

		const hash = computeSchemaHash(schema);
		expect(hash).to.be.a('string');
		expect(hash.length).to.be.greaterThan(0);
	});
});
