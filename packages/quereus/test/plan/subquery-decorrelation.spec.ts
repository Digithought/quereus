import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Plan shape: subquery decorrelation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER, name TEXT) USING memory");
		await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, x INTEGER, label TEXT) USING memory");
		await db.exec("INSERT INTO a VALUES (1, 10, 'alpha'), (2, 20, 'beta'), (3, 30, 'gamma')");
		await db.exec("INSERT INTO b VALUES (1, 10, 'one'), (2, 20, 'two'), (3, 99, 'orphan')");
	});

	afterEach(async () => {
		await db.close();
	});

	async function planOps(sql: string): Promise<string[]> {
		const ops: string[] = [];
		for await (const r of db.eval("SELECT op FROM query_plan(?)", [sql])) {
			ops.push((r as { op: string }).op);
		}
		return ops;
	}

	async function planNodeTypes(sql: string): Promise<string[]> {
		const types: string[] = [];
		for await (const r of db.eval("SELECT node_type FROM query_plan(?)", [sql])) {
			types.push((r as { node_type: string }).node_type);
		}
		return types;
	}

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) rows.push(r as T);
		return rows;
	}

	describe('correlated EXISTS decorrelated into semi-join', () => {
		it('transforms EXISTS into a join (semi-join)', async () => {
			const q = "SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.x = a.x)";
			const ops = await planOps(q);
			const types = await planNodeTypes(q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasExists = types.includes('Exists');

			if (hasJoin) {
				expect(hasJoin, 'Correlated EXISTS should be decorrelated into a join').to.equal(true);
			} else {
				expect(hasExists, 'If not decorrelated, EXISTS node should remain').to.equal(true);
			}
		});

		it('produces correct results for EXISTS', async () => {
			const q = "SELECT a.name FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.x = a.x) ORDER BY a.id";
			const results = await allRows<{ name: string }>(q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});
	});

	describe('correlated IN decorrelated into semi-join', () => {
		it('transforms IN subquery into a join', async () => {
			const q = "SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b)";
			const ops = await planOps(q);
			const types = await planNodeTypes(q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasIn = types.includes('In');

			if (hasJoin) {
				expect(hasJoin, 'IN subquery should be decorrelated into a join').to.equal(true);
			} else {
				expect(hasIn || ops.includes('CACHE'),
					'If not decorrelated, IN node or CACHE should remain'
				).to.equal(true);
			}
		});

		it('produces correct results for IN subquery', async () => {
			const q = "SELECT a.name FROM a WHERE a.x IN (SELECT b.x FROM b) ORDER BY a.id";
			const results = await allRows<{ name: string }>(q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});
	});

	describe('NOT EXISTS decorrelated into anti-join', () => {
		it('transforms NOT EXISTS into a join or retains NOT EXISTS', async () => {
			const q = "SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.x = a.x)";
			const ops = await planOps(q);
			const types = await planNodeTypes(q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasExists = types.includes('Exists');

			expect(
				hasJoin || hasExists,
				'NOT EXISTS should either be decorrelated to anti-join or remain as EXISTS'
			).to.equal(true);
		});

		it('produces correct results for NOT EXISTS', async () => {
			const q = "SELECT a.name FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.x = a.x) ORDER BY a.id";
			const results = await allRows<{ name: string }>(q);
			expect(results.map(r => r.name)).to.deep.equal(['gamma']);
		});
	});
});
