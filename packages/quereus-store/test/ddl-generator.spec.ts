/**
 * Tests for DDL generation utilities.
 */

import { expect } from 'chai';
import { generateTableDDL, generateIndexDDL } from '../src/common/ddl-generator.js';
import { INTEGER_TYPE, TEXT_TYPE, REAL_TYPE } from '@quereus/quereus';
import type { TableSchema, TableIndexSchema, ColumnSchema } from '@quereus/quereus';

/** Helper to build a minimal TableSchema for testing. */
function makeTableSchema(overrides: Partial<TableSchema> & { name: string; columns: ColumnSchema[] }): TableSchema {
	const columns = overrides.columns;
	const columnIndexMap = new Map(columns.map((c, i) => [c.name.toLowerCase(), i]));
	return {
		schemaName: 'main',
		primaryKeyDefinition: [],
		checkConstraints: [],
		vtabModule: {} as any,
		vtabModuleName: '',
		isView: false,
		columnIndexMap,
		...overrides,
	} as TableSchema;
}

/** Helper to build a minimal ColumnSchema. */
function makeColumn(name: string, type: ColumnSchema['logicalType'], opts?: Partial<ColumnSchema>): ColumnSchema {
	return {
		name,
		logicalType: type,
		notNull: true,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: '',
		generated: false,
		...opts,
	};
}

describe('DDL generator', () => {
	describe('generateTableDDL', () => {
		it('generates simple table with single PK', () => {
			const schema = makeTableSchema({
				name: 'users',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true, pkOrder: 0 }),
					makeColumn('name', TEXT_TYPE),
				],
				primaryKeyDefinition: [{ index: 0 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('CREATE TABLE');
			expect(ddl).to.include('"users"');
			expect(ddl).to.include('"id" INTEGER PRIMARY KEY');
			expect(ddl).to.include('"name" TEXT');
		});

		it('generates composite PK as table constraint', () => {
			const schema = makeTableSchema({
				name: 'order_items',
				columns: [
					makeColumn('order_id', INTEGER_TYPE, { primaryKey: true, pkOrder: 0 }),
					makeColumn('item_id', INTEGER_TYPE, { primaryKey: true, pkOrder: 1 }),
					makeColumn('qty', INTEGER_TYPE),
				],
				primaryKeyDefinition: [{ index: 0 }, { index: 1 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('PRIMARY KEY ("order_id", "item_id")');
			// Single-column PK annotation should NOT appear
			expect(ddl).not.to.match(/"order_id" INTEGER PRIMARY KEY/);
		});

		it('generates schema-qualified name for non-main schema', () => {
			const schema = makeTableSchema({
				name: 'items',
				schemaName: 'inventory',
				columns: [makeColumn('id', INTEGER_TYPE)],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"inventory"."items"');
		});

		it('includes TEMP for temporary tables', () => {
			const schema = makeTableSchema({
				name: 'tmp',
				isTemporary: true,
				columns: [makeColumn('x', INTEGER_TYPE)],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('TEMP');
		});

		it('includes USING clause for virtual tables', () => {
			const schema = makeTableSchema({
				name: 'data',
				vtabModuleName: 'store',
				columns: [makeColumn('id', INTEGER_TYPE)],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('USING store');
		});

		it('includes NULL annotation for nullable columns', () => {
			const schema = makeTableSchema({
				name: 'data',
				columns: [makeColumn('notes', TEXT_TYPE, { notNull: false })],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"notes" TEXT NULL');
		});
	});

	describe('generateIndexDDL', () => {
		const tableSchema = makeTableSchema({
			name: 'users',
			columns: [
				makeColumn('id', INTEGER_TYPE),
				makeColumn('email', TEXT_TYPE),
				makeColumn('score', REAL_TYPE),
			],
		});

		it('generates simple index', () => {
			const idx: TableIndexSchema = { name: 'idx_email', columns: [{ index: 1 }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('CREATE INDEX "idx_email"');
			expect(ddl).to.include('ON "users"');
			expect(ddl).to.include('"email"');
		});

		it('includes COLLATE for collated columns', () => {
			const idx: TableIndexSchema = { name: 'idx_email_nc', columns: [{ index: 1, collation: 'NOCASE' }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('COLLATE NOCASE');
		});

		it('includes DESC for descending columns', () => {
			const idx: TableIndexSchema = { name: 'idx_score_desc', columns: [{ index: 2, desc: true }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('DESC');
		});

		it('generates schema-qualified table name', () => {
			const schemaQualified = makeTableSchema({
				name: 'users',
				schemaName: 'auth',
				columns: [makeColumn('email', TEXT_TYPE)],
			});
			const idx: TableIndexSchema = { name: 'idx_email', columns: [{ index: 0 }] };
			const ddl = generateIndexDDL(idx, schemaQualified);
			expect(ddl).to.include('"auth"."users"');
		});
	});
});

