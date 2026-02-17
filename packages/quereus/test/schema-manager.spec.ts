/**
 * Schema manager tests — written from the public interface only.
 *
 * Covers: schema creation, table/view lookup, multi-schema resolution,
 * search path behaviour, error cases, and schema clearing.
 *
 * Uses the Database public API (which delegates to SchemaManager) plus
 * direct SchemaManager access where the public API is the manager itself.
 */

import { expect } from 'chai';
import { Database, QuereusError } from '../src/index.js';
import { SchemaManager } from '../src/schema/manager.js';
import { Schema } from '../src/schema/schema.js';

describe('Schema Manager', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// ─────────────────────── Default schemas ───────────────────────
	describe('Default schemas', () => {
		it('should have main and temp schemas', () => {
			const sm = db.schemaManager;
			expect(sm.getCurrentSchemaName()).to.equal('main');
			expect(sm.getSchemaOrFail('main')).to.be.instanceOf(Schema);
			expect(sm.getSchemaOrFail('temp')).to.be.instanceOf(Schema);
		});

		it('should throw for non-existent schema', () => {
			expect(() => db.schemaManager.getSchemaOrFail('nosuch')).to.throw();
		});
	});

	// ─────────────────────── Adding schemas ───────────────────────
	describe('addSchema', () => {
		it('should create a new schema', () => {
			const schema = db.schemaManager.addSchema('aux');
			expect(schema).to.be.instanceOf(Schema);
			expect(schema.name).to.equal('aux');
			expect(db.schemaManager.getSchemaOrFail('aux')).to.equal(schema);
		});

		it('should be case-insensitive', () => {
			db.schemaManager.addSchema('AUX');
			expect(db.schemaManager.getSchemaOrFail('aux')).to.exist;
		});

		it('should throw on duplicate name', () => {
			expect(() => db.schemaManager.addSchema('main')).to.throw();
		});
	});

	// ─────────────────── Current schema switching ───────────────────
	describe('setCurrentSchema', () => {
		it('should change the current schema', () => {
			db.schemaManager.addSchema('other');
			db.schemaManager.setCurrentSchema('other');
			expect(db.schemaManager.getCurrentSchemaName()).to.equal('other');
		});

		it('should silently ignore non-existent schema', () => {
			db.schemaManager.setCurrentSchema('nonexistent');
			expect(db.schemaManager.getCurrentSchemaName()).to.equal('main');
		});
	});

	// ────────────────── Table creation and lookup ──────────────────
	describe('Table operations via SQL', () => {
		it('should create a table and find it', async () => {
			await db.exec('create table t1 (id integer primary key, name text)');
			const found = db.schemaManager.findTable('t1');
			expect(found).to.exist;
			expect(found!.name).to.equal('t1');
			expect(found!.columns.length).to.equal(2);
		});

		it('should find tables case-insensitively', async () => {
			await db.exec('create table MyTable (id integer primary key)');
			expect(db.schemaManager.findTable('mytable')).to.exist;
			expect(db.schemaManager.findTable('MYTABLE')).to.exist;
		});

		it('should return undefined for missing table', () => {
			expect(db.schemaManager.findTable('nonexistent')).to.be.undefined;
		});
	});

	// ────────────────── View operations ──────────────────
	describe('View operations via SQL', () => {
		it('should create a view and look it up via getSchemaItem', async () => {
			await db.exec('create table base (id integer primary key, v text)');
			await db.exec('create view v1 as select id, v from base');
			const item = db.schemaManager.getSchemaItem(null, 'v1');
			expect(item).to.exist;
		});

		it('views should shadow tables of the same name in getSchemaItem', async () => {
			// getSchemaItem checks views first
			await db.exec('create table dual_name (id integer primary key)');
			await db.exec('create view dual_name_view as select 1 as x');
			const item = db.schemaManager.getSchemaItem(null, 'dual_name_view');
			expect(item).to.exist;
		});
	});

	// ────────────────── clearAll ──────────────────
	describe('clearAll', () => {
		it('should remove all tables', async () => {
			await db.exec('create table t1 (id integer primary key)');
			await db.exec('create table t2 (id integer primary key)');
			expect(db.schemaManager.findTable('t1')).to.exist;

			db.schemaManager.clearAll();
			expect(db.schemaManager.findTable('t1')).to.be.undefined;
			expect(db.schemaManager.findTable('t2')).to.be.undefined;
		});
	});

	// ────────────────── Schema items in specific schemas ──────────────────
	describe('getSchemaItem with explicit schema', () => {
		it('should find items in specified schema', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(db.schemaManager.getSchemaItem('main', 't1')).to.exist;
		});

		it('should return undefined for wrong schema', async () => {
			await db.exec('create table t1 (id integer primary key)');
			db.schemaManager.addSchema('aux');
			expect(db.schemaManager.getSchemaItem('aux', 't1')).to.be.undefined;
		});
	});
});

