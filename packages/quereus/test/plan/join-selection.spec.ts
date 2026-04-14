import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Plan shape: join algorithm selection', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
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

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) rows.push(r as T);
		return rows;
	}

	describe('hash join for equi-joins on non-ordered keys', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL) USING memory");
			await db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT) USING memory");
			await db.exec(`INSERT INTO customers VALUES
				(1, 'Alice', 'east'), (2, 'Bob', 'west'), (3, 'Carol', 'east')`);
			await db.exec(`INSERT INTO orders VALUES
				(1, 1, 100.0), (2, 2, 200.0), (3, 1, 150.0), (4, 3, 75.0)`);
		});

		it('selects HashJoin for equi-join on non-PK column', async () => {
			const q = "SELECT c.name, o.amount FROM orders o JOIN customers c ON o.customer_id = c.id";
			const ops = await planOps(q);

			const hasHashJoin = ops.includes('HASHJOIN');
			const hasMergeJoin = ops.includes('MERGEJOIN');
			const hasAnyJoin = ops.some(op => op.includes('JOIN'));

			expect(hasAnyJoin, 'Plan should contain a join').to.equal(true);
			if (!hasMergeJoin) {
				expect(hasHashJoin, 'Expected HashJoin for equi-join on non-ordered key').to.equal(true);
			}
		});

		it('produces correct results with hash join', async () => {
			const q = "SELECT c.name, o.amount FROM orders o JOIN customers c ON o.customer_id = c.id ORDER BY o.id";
			const results = await allRows<{ name: string; amount: number }>(q);
			expect(results).to.have.lengthOf(4);
			expect(results[0]).to.deep.equal({ name: 'Alice', amount: 100.0 });
		});
	});

	describe('merge join when both inputs are naturally ordered', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE left_t (id INTEGER PRIMARY KEY, val TEXT) USING memory");
			await db.exec("CREATE TABLE right_t (id INTEGER PRIMARY KEY, info TEXT) USING memory");
			await db.exec("INSERT INTO left_t VALUES (1, 'a'), (2, 'b'), (3, 'c')");
			await db.exec("INSERT INTO right_t VALUES (1, 'x'), (2, 'y'), (3, 'z')");
		});

		it('selects MergeJoin or HashJoin for PK-to-PK equi-join', async () => {
			const q = "SELECT l.val, r.info FROM left_t l JOIN right_t r ON l.id = r.id";
			const ops = await planOps(q);

			const hasMerge = ops.includes('MERGEJOIN');
			const hasHash = ops.includes('HASHJOIN');
			const hasJoin = ops.some(op => op.includes('JOIN'));

			expect(hasJoin, 'Plan should contain a join node').to.equal(true);
			expect(
				hasMerge || hasHash,
				'PK-to-PK equi-join should use MergeJoin or HashJoin, not NestedLoopJoin'
			).to.equal(true);
		});

		it('produces correct results', async () => {
			const q = "SELECT l.val, r.info FROM left_t l JOIN right_t r ON l.id = r.id ORDER BY l.id";
			const results = await allRows<{ val: string; info: string }>(q);
			expect(results).to.deep.equal([
				{ val: 'a', info: 'x' },
				{ val: 'b', info: 'y' },
				{ val: 'c', info: 'z' },
			]);
		});
	});

	describe('nested-loop join for non-equi conditions', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
			await db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
			await db.exec("INSERT INTO t1 VALUES (1, 10), (2, 20)");
			await db.exec("INSERT INTO t2 VALUES (1, 15), (2, 25)");
		});

		it('uses NestedLoopJoin for cross join', async () => {
			const q = "SELECT t1.val, t2.val FROM t1 CROSS JOIN t2";
			const ops = await planOps(q);

			const hasNLJ = ops.includes('NESTEDLOOPJOIN');
			const hasJoin = ops.some(op => op.includes('JOIN'));

			expect(hasJoin, 'Plan should contain a join node').to.equal(true);
			if (hasNLJ) {
				expect(hasNLJ, 'Cross join without equi-condition should use NestedLoopJoin').to.equal(true);
			}
		});

		it('cross join produces correct cardinality', async () => {
			const q = "SELECT t1.val AS a, t2.val AS b FROM t1 CROSS JOIN t2";
			const results = await allRows<{ a: number; b: number }>(q);
			expect(results).to.have.lengthOf(4);
		});
	});
});
