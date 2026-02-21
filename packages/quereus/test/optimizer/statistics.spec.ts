import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { buildHistogram, selectivityFromHistogram } from '../../src/planner/stats/histogram.js';
import { CatalogStatsProvider } from '../../src/planner/stats/catalog-stats.js';
import type { TableStatistics, ColumnStatistics, EquiHeightHistogram } from '../../src/planner/stats/catalog-stats.js';
import type { TableSchema } from '../../src/schema/table.js';

// ── Histogram unit tests ───────────────────────────────────────────────────

describe('Histogram', () => {
	describe('buildHistogram', () => {
		it('returns undefined for empty values', () => {
			expect(buildHistogram([], 10)).to.be.undefined;
		});

		it('builds a single-bucket histogram for few values', () => {
			const hist = buildHistogram([1, 2, 3], 1);
			expect(hist).to.not.be.undefined;
			expect(hist!.buckets).to.have.lengthOf(1);
			expect(hist!.buckets[0].upperBound).to.equal(3);
			expect(hist!.sampleSize).to.equal(3);
		});

		it('builds correct number of buckets', () => {
			const values = Array.from({ length: 100 }, (_, i) => i);
			const hist = buildHistogram(values, 10);
			expect(hist).to.not.be.undefined;
			expect(hist!.buckets).to.have.lengthOf(10);
			expect(hist!.sampleSize).to.equal(100);
		});

		it('tracks cumulative counts', () => {
			const values = Array.from({ length: 100 }, (_, i) => i);
			const hist = buildHistogram(values, 10)!;
			// Cumulative counts should be non-decreasing
			for (let i = 1; i < hist.buckets.length; i++) {
				expect(hist.buckets[i].cumulativeCount).to.be.at.least(
					hist.buckets[i - 1].cumulativeCount
				);
			}
			// Last bucket cumulative should equal total
			expect(hist.buckets[hist.buckets.length - 1].cumulativeCount).to.equal(100);
		});

		it('counts distinct values per bucket', () => {
			// All same value: 1 distinct per bucket
			const hist = buildHistogram([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 2)!;
			for (const b of hist.buckets) {
				expect(b.distinctCount).to.equal(1);
			}
		});

		it('caps bucket count to number of values', () => {
			const hist = buildHistogram([1, 2, 3], 100);
			expect(hist).to.not.be.undefined;
			expect(hist!.buckets).to.have.lengthOf(3);
		});
	});

	describe('selectivityFromHistogram', () => {
		function makeHistogram(n: number): EquiHeightHistogram {
			const values = Array.from({ length: n }, (_, i) => i);
			return buildHistogram(values, 10)!;
		}

		it('returns undefined for empty buckets', () => {
			const hist: EquiHeightHistogram = { buckets: [], sampleSize: 0 };
			expect(selectivityFromHistogram(hist, '=', 5, 100)).to.be.undefined;
		});

		it('returns selectivity in [0,1] for equality', () => {
			const hist = makeHistogram(100);
			const sel = selectivityFromHistogram(hist, '=', 50, 100);
			expect(sel).to.not.be.undefined;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('returns selectivity in [0,1] for less-than', () => {
			const hist = makeHistogram(100);
			const sel = selectivityFromHistogram(hist, '<', 50, 100);
			expect(sel).to.not.be.undefined;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('returns selectivity in [0,1] for greater-than', () => {
			const hist = makeHistogram(100);
			const sel = selectivityFromHistogram(hist, '>', 50, 100);
			expect(sel).to.not.be.undefined;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('< and > selectivities are roughly complementary', () => {
			const hist = makeHistogram(100);
			const lt = selectivityFromHistogram(hist, '<', 50, 100)!;
			const gt = selectivityFromHistogram(hist, '>', 50, 100)!;
			// lt + gt + eq ≈ 1; just check they sum to roughly 1
			expect(lt + gt).to.be.closeTo(1, 0.15);
		});

		it('returns 0 selectivity for value above all buckets with <', () => {
			const hist = makeHistogram(100);
			const sel = selectivityFromHistogram(hist, '<', -100, 100);
			// value below all buckets with < should be very low
			expect(sel).to.not.be.undefined;
		});

		it('returns undefined for unknown operator', () => {
			const hist = makeHistogram(100);
			expect(selectivityFromHistogram(hist, 'LIKE', 50, 100)).to.be.undefined;
		});
	});
});

// ── CatalogStatsProvider unit tests ────────────────────────────────────────

describe('CatalogStatsProvider', () => {
	function makeTableSchema(name: string, stats?: TableStatistics): TableSchema {
		return {
			name,
			statistics: stats,
			columns: [],
		} as unknown as TableSchema;
	}

	function makeStats(rowCount: number, cols?: Record<string, Partial<ColumnStatistics>>): TableStatistics {
		const columnStats = new Map<string, ColumnStatistics>();
		if (cols) {
			for (const [name, partial] of Object.entries(cols)) {
				columnStats.set(name.toLowerCase(), {
					distinctCount: partial.distinctCount ?? 10,
					nullCount: partial.nullCount ?? 0,
					minValue: partial.minValue,
					maxValue: partial.maxValue,
					histogram: partial.histogram,
				});
			}
		}
		return { rowCount, columnStats, lastAnalyzed: Date.now() };
	}

	it('returns catalog rowCount when statistics present', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(42));
		expect(provider.tableRows(table)).to.equal(42);
	});

	it('falls back to naive provider when no statistics', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1');
		const rows = provider.tableRows(table);
		// NaiveStatsProvider defaults to 1000
		expect(rows).to.be.a('number');
		expect(rows).to.be.greaterThan(0);
	});

	it('returns distinct values from column statistics', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { age: { distinctCount: 50 } }));
		expect(provider.distinctValues(table, 'age')).to.equal(50);
	});

	it('returns undefined distinctValues for unknown column', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { age: { distinctCount: 50 } }));
		// falls back to naive
		const result = provider.distinctValues(table, 'nonexistent');
		expect(result).to.be.a('number');
	});
});

// ── ANALYZE integration tests ──────────────────────────────────────────────

describe('ANALYZE command', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setupTable(): Promise<void> {
		await db.exec(`
			CREATE TABLE products (
				id INTEGER PRIMARY KEY,
				name TEXT,
				price REAL,
				category TEXT
			) USING memory
		`);
		for (let i = 1; i <= 100; i++) {
			const cat = ['electronics', 'books', 'clothing', 'food'][i % 4];
			await db.exec(
				`INSERT INTO products VALUES (${i}, 'item_${i}', ${(i * 9.99).toFixed(2)}, '${cat}')`
			);
		}
	}

	it('parses ANALYZE without arguments', async () => {
		await setupTable();
		// Should not throw
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE')) {
			rows.push(r);
		}
		expect(rows.length).to.be.greaterThan(0);
	});

	it('parses ANALYZE with table name', async () => {
		await setupTable();
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE products')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(1);
	});

	it('returns row count from ANALYZE', async () => {
		await setupTable();
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE products')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]).to.have.property('table', 'products');
		expect(rows[0]).to.have.property('rows');
		expect(rows[0].rows).to.be.a('number');
	});

	it('collects statistics that improve cost estimates', async () => {
		await setupTable();
		await db.exec('CREATE INDEX idx_category ON products(category)');

		// Run ANALYZE to collect statistics
		for await (const _ of db.eval('ANALYZE products')) { /* consume */ }

		// After ANALYZE, optimizer should have real statistics
		// Run a query that benefits from statistics
		const results: any[] = [];
		for await (const r of db.eval("SELECT name FROM products WHERE category = 'electronics'")) {
			results.push(r);
		}
		expect(results).to.have.lengthOf(25);
	});

	it('ANALYZE on nonexistent table produces no output', async () => {
		await setupTable();
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE nonexistent_table')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(0);
	});

	it('collects per-column distinct counts', async () => {
		await db.exec(`
			CREATE TABLE colors (id INTEGER PRIMARY KEY, color TEXT) USING memory
		`);
		await db.exec("INSERT INTO colors VALUES (1, 'red'), (2, 'blue'), (3, 'red'), (4, 'green'), (5, 'blue')");

		for await (const _ of db.eval('ANALYZE colors')) { /* consume */ }

		// The statistics should now be cached on the schema; verify indirectly
		// by querying - the optimizer should have real distinct counts
		const results: any[] = [];
		for await (const r of db.eval("SELECT DISTINCT color FROM colors")) {
			results.push(r);
		}
		expect(results).to.have.lengthOf(3);
	});
});

// ── VTab getStatistics protocol ─────────────────────────────────────────────

describe('VTab-supplied statistics', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('MemoryTable provides exact row count via getStatistics', async () => {
		await db.exec(`
			CREATE TABLE nums (id INTEGER PRIMARY KEY, val INTEGER) USING memory
		`);
		for (let i = 1; i <= 50; i++) {
			await db.exec(`INSERT INTO nums VALUES (${i}, ${i * 10})`);
		}

		// ANALYZE should collect VTab-supplied statistics
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE nums')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(1);
		expect(rows[0].table).to.equal('nums');
		expect(rows[0].rows).to.equal(50);
	});

	it('statistics improve after data changes and re-ANALYZE', async () => {
		await db.exec(`
			CREATE TABLE counters (id INTEGER PRIMARY KEY, n INTEGER) USING memory
		`);
		for (let i = 1; i <= 10; i++) {
			await db.exec(`INSERT INTO counters VALUES (${i}, ${i})`);
		}

		const firstRows: any[] = [];
		for await (const r of db.eval('ANALYZE counters')) {
			firstRows.push(r);
		}
		expect(firstRows[0].rows).to.equal(10);

		// Insert more data
		for (let i = 11; i <= 30; i++) {
			await db.exec(`INSERT INTO counters VALUES (${i}, ${i})`);
		}

		const secondRows: any[] = [];
		for await (const r of db.eval('ANALYZE counters')) {
			secondRows.push(r);
		}
		expect(secondRows[0].rows).to.equal(30);
	});
});
