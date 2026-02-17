/**
 * Tests for key-builder utilities.
 */

import { expect } from 'chai';
import {
	buildDataStoreName,
	buildIndexStoreName,
	buildStatsStoreName,
	buildStatsKey,
	buildDataKey,
	buildIndexKey,
	buildCatalogKey,
	buildFullScanBounds,
	buildIndexPrefixBounds,
	buildCatalogScanBounds,
	STORE_SUFFIX,
	CATALOG_STORE_NAME,
	STATS_STORE_NAME,
} from '../src/common/key-builder.js';

const encoder = new TextEncoder();

describe('key-builder', () => {
	describe('constants', () => {
		it('STORE_SUFFIX has INDEX and STATS', () => {
			expect(STORE_SUFFIX.INDEX).to.equal('_idx_');
			expect(STORE_SUFFIX.STATS).to.equal('_stats');
		});

		it('CATALOG_STORE_NAME is __catalog__', () => {
			expect(CATALOG_STORE_NAME).to.equal('__catalog__');
		});

		it('STATS_STORE_NAME is __stats__', () => {
			expect(STATS_STORE_NAME).to.equal('__stats__');
		});
	});

	describe('buildDataStoreName', () => {
		it('returns lowercase schema.table', () => {
			expect(buildDataStoreName('Main', 'Users')).to.equal('main.users');
		});

		it('preserves dots and underscores', () => {
			expect(buildDataStoreName('my_schema', 'my_table')).to.equal('my_schema.my_table');
		});
	});

	describe('buildIndexStoreName', () => {
		it('returns lowercase schema.table_idx_name', () => {
			expect(buildIndexStoreName('Main', 'Users', 'ByEmail')).to.equal('main.users_idx_byemail');
		});
	});

	describe('buildStatsStoreName (deprecated)', () => {
		it('returns lowercase schema.table_stats', () => {
			expect(buildStatsStoreName('Main', 'Users')).to.equal('main.users_stats');
		});
	});

	describe('buildStatsKey', () => {
		it('returns UTF-8 encoded lowercase schema.table', () => {
			const key = buildStatsKey('Main', 'Users');
			expect(key).to.deep.equal(encoder.encode('main.users'));
		});
	});

	describe('buildDataKey', () => {
		it('encodes single value', () => {
			const key = buildDataKey([42]);
			expect(key).to.be.instanceOf(Uint8Array);
			expect(key.length).to.be.greaterThan(0);
		});

		it('encodes multiple values', () => {
			const key = buildDataKey([1, 'hello']);
			expect(key).to.be.instanceOf(Uint8Array);
			expect(key.length).to.be.greaterThan(0);
		});
	});

	describe('buildIndexKey', () => {
		it('concatenates index key and pk key', () => {
			const key = buildIndexKey(['alice'], [1]);
			const indexOnly = buildDataKey(['alice']);
			const pkOnly = buildDataKey([1]);
			expect(key.length).to.equal(indexOnly.length + pkOnly.length);
		});
	});

	describe('buildCatalogKey', () => {
		it('returns UTF-8 encoded lowercase schema.table', () => {
			const key = buildCatalogKey('Main', 'Users');
			expect(key).to.deep.equal(encoder.encode('main.users'));
		});
	});

	describe('buildFullScanBounds', () => {
		it('returns gte=empty, lt=[0xff]', () => {
			const bounds = buildFullScanBounds();
			expect(bounds.gte).to.deep.equal(new Uint8Array(0));
			expect(bounds.lt).to.deep.equal(new Uint8Array([0xff]));
		});
	});

	describe('buildIndexPrefixBounds', () => {
		it('returns full scan for empty prefix', () => {
			const bounds = buildIndexPrefixBounds([]);
			expect(bounds.gte).to.deep.equal(new Uint8Array(0));
			expect(bounds.lt).to.deep.equal(new Uint8Array([0xff]));
		});

		it('returns prefix-based range for non-empty prefix', () => {
			const bounds = buildIndexPrefixBounds(['alice']);
			expect(bounds.gte.length).to.be.greaterThan(0);
			expect(bounds.lt.length).to.be.greaterThan(0);
			// lt should be greater than gte
			const gteHex = Array.from(bounds.gte).map(b => b.toString(16).padStart(2, '0')).join('');
			const ltHex = Array.from(bounds.lt).map(b => b.toString(16).padStart(2, '0')).join('');
			expect(ltHex > gteHex).to.be.true;
		});
	});

	describe('buildCatalogScanBounds', () => {
		it('returns full scan without schema filter', () => {
			const bounds = buildCatalogScanBounds();
			expect(bounds.gte).to.deep.equal(new Uint8Array(0));
			expect(bounds.lt).to.deep.equal(new Uint8Array([0xff]));
		});

		it('returns schema-prefixed range with filter', () => {
			const bounds = buildCatalogScanBounds('Main');
			const prefix = encoder.encode('main.');
			expect(bounds.gte).to.deep.equal(prefix);
			expect(bounds.lt.length).to.be.greaterThan(0);
		});
	});
});

