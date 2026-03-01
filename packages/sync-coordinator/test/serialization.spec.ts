/**
 * Tests for shared serialization utilities.
 */

import { expect } from 'chai';
import {
	createHLC,
	generateSiteId,
	siteIdToBase64,
	type ChangeSet,
	type SnapshotChunk,
	type SchemaMigration,
} from '@quereus/sync';
import {
	serializeChangeSet,
	deserializeChangeSet,
	serializeSnapshotChunk,
	deserializeSnapshotChunk,
} from '../src/common/serialization.js';

function makeTestHLC() {
	return createHLC(BigInt(Date.now()) * 1000n, 0, generateSiteId());
}

function makeTestChangeSet(): ChangeSet {
	const siteId = generateSiteId();
	const hlc = createHLC(BigInt(Date.now()) * 1000n, 1, siteId);
	return {
		siteId,
		transactionId: 'tx-123',
		hlc,
		changes: [
			{
				type: 'column' as const,
				schema: 'main',
				table: 'users',
				pk: ['user-1'],
				column: 'name',
				value: 'Alice',
				hlc: createHLC(BigInt(Date.now()) * 1000n, 2, siteId),
			},
		],
		schemaMigrations: [
			{
				type: 'create-table' as const,
				schema: 'main',
				table: 'users',
				hlc: createHLC(BigInt(Date.now()) * 1000n, 3, siteId),
				sql: 'create table users (id text primary key, name text)',
			} as SchemaMigration,
		],
	};
}

describe('Serialization', () => {
	describe('serializeChangeSet / deserializeChangeSet', () => {
		it('should round-trip a ChangeSet through serialize then deserialize', () => {
			const original = makeTestChangeSet();
			const serialized = serializeChangeSet(original);
			const deserialized = deserializeChangeSet(serialized);

			// siteId should round-trip
			expect(siteIdToBase64(deserialized.siteId)).to.equal(siteIdToBase64(original.siteId));
			expect(deserialized.transactionId).to.equal(original.transactionId);

			// HLC should round-trip (compare wallTime and counter)
			expect(deserialized.hlc.wallTime).to.equal(original.hlc.wallTime);
			expect(deserialized.hlc.counter).to.equal(original.hlc.counter);

			// Changes should round-trip
			expect(deserialized.changes).to.have.length(1);
			const change = deserialized.changes[0] as any;
			expect(change.type).to.equal('column');
			expect(change.schema).to.equal('main');
			expect(change.table).to.equal('users');
			expect(change.value).to.equal('Alice');
			expect(change.hlc.wallTime).to.equal((original.changes[0] as any).hlc.wallTime);

			// Schema migrations should round-trip
			expect(deserialized.schemaMigrations).to.have.length(1);
			const migration = deserialized.schemaMigrations[0] as any;
			expect(migration.type).to.equal('create-table');
			expect(migration.hlc.wallTime).to.equal((original.schemaMigrations[0] as any).hlc.wallTime);
		});

		it('should produce JSON-safe output (no BigInt, no Uint8Array)', () => {
			const original = makeTestChangeSet();
			const serialized = serializeChangeSet(original);

			// Should be JSON-serializable without error
			const json = JSON.stringify(serialized);
			expect(json).to.be.a('string');

			// siteId should be a base64 string
			expect((serialized as any).siteId).to.be.a('string');
			// hlc should be a base64 string
			expect((serialized as any).hlc).to.be.a('string');
		});

		it('should handle empty changes and schemaMigrations', () => {
			const siteId = generateSiteId();
			const cs: ChangeSet = {
				siteId,
				transactionId: 'tx-empty',
				hlc: makeTestHLC(),
				changes: [],
				schemaMigrations: [],
			};

			const serialized = serializeChangeSet(cs);
			const deserialized = deserializeChangeSet(serialized);

			expect(deserialized.changes).to.have.length(0);
			expect(deserialized.schemaMigrations).to.have.length(0);
			expect(deserialized.transactionId).to.equal('tx-empty');
		});
	});

	describe('serializeSnapshotChunk', () => {
		it('should serialize header chunk with base64 fields', () => {
			const siteId = generateSiteId();
			const hlc = makeTestHLC();
			const chunk: SnapshotChunk = {
				type: 'header',
				siteId,
				hlc,
				tableCount: 3,
				migrationCount: 1,
				snapshotId: 'snap-1',
			};

			const serialized = serializeSnapshotChunk(chunk) as any;

			expect(serialized.type).to.equal('header');
			expect(serialized.siteId).to.be.a('string');
			expect(serialized.hlc).to.be.a('string');
			expect(serialized.tableCount).to.equal(3);
			expect(serialized.snapshotId).to.equal('snap-1');

			// Should be JSON-safe
			expect(() => JSON.stringify(serialized)).to.not.throw();
		});

		it('should serialize column-versions chunk with base64 HLCs', () => {
			const hlc = makeTestHLC();
			const chunk: SnapshotChunk = {
				type: 'column-versions',
				schema: 'main',
				table: 'users',
				entries: [['key1', hlc, 'value1']],
			};

			const serialized = serializeSnapshotChunk(chunk) as any;

			expect(serialized.type).to.equal('column-versions');
			expect(serialized.entries).to.have.length(1);
			expect(serialized.entries[0][0]).to.equal('key1');
			expect(serialized.entries[0][1]).to.be.a('string'); // HLC as base64
			expect(serialized.entries[0][2]).to.equal('value1');
		});

		it('should serialize schema-migration chunk with base64 HLC', () => {
			const hlc = makeTestHLC();
			const chunk: SnapshotChunk = {
				type: 'schema-migration',
				migration: {
					type: 'create-table',
					schema: 'main',
					table: 'items',
					hlc,
					sql: 'create table items (id text primary key)',
				} as SchemaMigration,
			};

			const serialized = serializeSnapshotChunk(chunk) as any;

			expect(serialized.type).to.equal('schema-migration');
			expect(serialized.migration.hlc).to.be.a('string');
			expect(serialized.migration.type).to.equal('create-table');
		});

		it('should pass through table-start/table-end/footer chunks unchanged', () => {
			const tableStart: SnapshotChunk = {
				type: 'table-start',
				schema: 'main',
				table: 'users',
				estimatedEntries: 100,
			};
			const tableEnd: SnapshotChunk = {
				type: 'table-end',
				schema: 'main',
				table: 'users',
				entriesWritten: 95,
			};
			const footer: SnapshotChunk = {
				type: 'footer',
				snapshotId: 'snap-1',
				totalTables: 3,
				totalEntries: 200,
				totalMigrations: 1,
			};

			expect(serializeSnapshotChunk(tableStart)).to.deep.equal(tableStart);
			expect(serializeSnapshotChunk(tableEnd)).to.deep.equal(tableEnd);
			expect(serializeSnapshotChunk(footer)).to.deep.equal(footer);
		});
	});

	describe('deserializeSnapshotChunk (round-trip)', () => {
		it('should round-trip header chunk through serialize then deserialize', () => {
			const siteId = generateSiteId();
			const hlc = makeTestHLC();
			const original: SnapshotChunk = {
				type: 'header',
				siteId,
				hlc,
				tableCount: 5,
				migrationCount: 2,
				snapshotId: 'snap-rt-1',
			};

			const serialized = serializeSnapshotChunk(original);
			const deserialized = deserializeSnapshotChunk(serialized);

			expect(deserialized.type).to.equal('header');
			const hdr = deserialized as typeof original;
			expect(siteIdToBase64(hdr.siteId)).to.equal(siteIdToBase64(siteId));
			expect(hdr.hlc.wallTime).to.equal(hlc.wallTime);
			expect(hdr.hlc.counter).to.equal(hlc.counter);
			expect(hdr.tableCount).to.equal(5);
			expect(hdr.migrationCount).to.equal(2);
			expect(hdr.snapshotId).to.equal('snap-rt-1');
		});

		it('should round-trip column-versions chunk through serialize then deserialize', () => {
			const hlc = makeTestHLC();
			const original: SnapshotChunk = {
				type: 'column-versions',
				schema: 'main',
				table: 'items',
				entries: [
					['pk1', hlc, 'value-a'],
					['pk2', hlc, 42],
				],
			};

			const serialized = serializeSnapshotChunk(original);
			const deserialized = deserializeSnapshotChunk(serialized);

			expect(deserialized.type).to.equal('column-versions');
			const cv = deserialized as typeof original;
			expect(cv.schema).to.equal('main');
			expect(cv.table).to.equal('items');
			expect(cv.entries).to.have.length(2);
			expect(cv.entries[0][0]).to.equal('pk1');
			expect(cv.entries[0][1].wallTime).to.equal(hlc.wallTime);
			expect(cv.entries[0][2]).to.equal('value-a');
			expect(cv.entries[1][0]).to.equal('pk2');
			expect(cv.entries[1][2]).to.equal(42);
		});

		it('should round-trip schema-migration chunk through serialize then deserialize', () => {
			const hlc = makeTestHLC();
			const original: SnapshotChunk = {
				type: 'schema-migration',
				migration: {
					type: 'create-table',
					schema: 'main',
					table: 'products',
					hlc,
					sql: 'create table products (id text primary key, name text)',
				} as SchemaMigration,
			};

			const serialized = serializeSnapshotChunk(original);
			const deserialized = deserializeSnapshotChunk(serialized);

			expect(deserialized.type).to.equal('schema-migration');
			const sm = deserialized as typeof original;
			expect(sm.migration.type).to.equal('create-table');
			expect(sm.migration.hlc.wallTime).to.equal(hlc.wallTime);
			expect((sm.migration as any).sql).to.equal('create table products (id text primary key, name text)');
		});

		it('should round-trip pass-through chunks unchanged', () => {
			const footer: SnapshotChunk = {
				type: 'footer',
				snapshotId: 'snap-2',
				totalTables: 10,
				totalEntries: 500,
				totalMigrations: 3,
			};

			const serialized = serializeSnapshotChunk(footer);
			const deserialized = deserializeSnapshotChunk(serialized);

			expect(deserialized).to.deep.equal(footer);
		});

		it('should survive JSON.stringify/parse round-trip (simulates S3 storage)', () => {
			const siteId = generateSiteId();
			const hlc = makeTestHLC();
			const chunks: SnapshotChunk[] = [
				{
					type: 'header',
					siteId,
					hlc,
					tableCount: 1,
					migrationCount: 0,
					snapshotId: 'snap-json-rt',
				},
				{
					type: 'table-start',
					schema: 'main',
					table: 'data',
					estimatedEntries: 2,
				},
				{
					type: 'column-versions',
					schema: 'main',
					table: 'data',
					entries: [['row1', hlc, 'hello']],
				},
				{
					type: 'table-end',
					schema: 'main',
					table: 'data',
					entriesWritten: 1,
				},
				{
					type: 'footer',
					snapshotId: 'snap-json-rt',
					totalTables: 1,
					totalEntries: 1,
					totalMigrations: 0,
				},
			];

			// Simulate S3 store/download: serialize → JSON.stringify → JSON.parse → deserialize
			const serialized = chunks.map(c => serializeSnapshotChunk(c));
			const json = JSON.stringify(serialized);
			const parsed = JSON.parse(json) as unknown[];
			const restored = parsed.map(c => deserializeSnapshotChunk(c));

			expect(restored).to.have.length(5);
			expect(restored[0].type).to.equal('header');
			const hdr = restored[0] as any;
			expect(siteIdToBase64(hdr.siteId)).to.equal(siteIdToBase64(siteId));
			expect(hdr.hlc.wallTime).to.equal(hlc.wallTime);

			expect(restored[2].type).to.equal('column-versions');
			const cv = restored[2] as any;
			expect(cv.entries[0][0]).to.equal('row1');
			expect(cv.entries[0][1].wallTime).to.equal(hlc.wallTime);
			expect(cv.entries[0][2]).to.equal('hello');

			expect(restored[4].type).to.equal('footer');
		});
	});
});
