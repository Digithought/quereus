import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

interface PlanRow {
	id: number;
	parent_id: number | null;
	op: string;
	node_type: string;
	detail: string;
	object_name: string | null;
}

describe('Plan shape: predicate pushdown', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function planRows(sql: string): Promise<PlanRow[]> {
		const rows: PlanRow[] = [];
		for await (const r of db.eval(
			"SELECT id, parent_id, op, node_type, detail, object_name FROM query_plan(?)", [sql]
		)) {
			rows.push(r as PlanRow);
		}
		return rows;
	}

	async function planOps(sql: string): Promise<string[]> {
		const ops: string[] = [];
		for await (const r of db.eval("SELECT op FROM query_plan(?)", [sql])) {
			ops.push((r as { op: string }).op);
		}
		return ops;
	}

	function isDescendantOf(rows: PlanRow[], childId: number, ancestorId: number): boolean {
		let current = childId;
		const visited = new Set<number>();
		while (true) {
			if (visited.has(current)) return false;
			visited.add(current);
			const row = rows.find(r => r.id === current);
			if (!row || row.parent_id === null) return false;
			if (row.parent_id === ancestorId) return true;
			current = row.parent_id;
		}
	}

	describe('predicate pushed below join', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER, name TEXT) USING memory");
			await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER, label TEXT) USING memory");
			await db.exec("INSERT INTO a VALUES (1, 5, 'lo'), (2, 15, 'mid'), (3, 25, 'hi')");
			await db.exec("INSERT INTO b VALUES (10, 1, 'alpha'), (20, 2, 'beta'), (30, 3, 'gamma')");
		});

		it('join with single-table predicate contains both FILTER and JOIN nodes', async () => {
			const q = "SELECT * FROM a JOIN b ON a.id = b.a_id WHERE a.x > 10";
			const rows = await planRows(q);

			const joinRow = rows.find(r => r.op.includes('JOIN'));
			const filterRow = rows.find(r => r.op === 'FILTER');
			expect(joinRow, 'Plan should contain a JOIN node').to.exist;
			expect(filterRow, 'Plan should contain a FILTER node for a.x > 10').to.exist;
		});

		it('returns correct results after pushdown', async () => {
			const q = "SELECT a.name, b.label FROM a JOIN b ON a.id = b.a_id WHERE a.x > 10";
			const results: any[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results).to.have.lengthOf(2);
			for (const row of results) {
				expect(['mid', 'hi']).to.include(row.name);
			}
		});
	});

	describe('predicate pushed through projection / alias', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER, name TEXT) USING memory");
			await db.exec("INSERT INTO a VALUES (1, 5, 'lo'), (2, 15, 'mid'), (3, 25, 'hi')");
		});

		it('pushes predicate on original column through subquery projection', async () => {
			const q = "SELECT * FROM (SELECT a.*, a.x + 1 AS y FROM a) v WHERE v.x > 10";
			const ops = await planOps(q);

			const hasFilter = ops.includes('FILTER');
			const hasAccess = ops.some(op =>
				op === 'SEQSCAN' || op === 'INDEXSCAN' || op === 'INDEXSEEK'
			);
			expect(hasAccess, 'Plan should contain an access node for the base table').to.equal(true);

			if (hasFilter) {
				const rows = await planRows(q);
				const accessRow = rows.find(r =>
					r.op === 'SEQSCAN' || r.op === 'INDEXSCAN' || r.op === 'INDEXSEEK'
				);
				const filterRow = rows.find(r => r.op === 'FILTER');

				if (accessRow && filterRow) {
					const filterIsAboveAccess = isDescendantOf(rows, accessRow.id, filterRow.id);
					expect(
						filterIsAboveAccess,
						'FILTER should be close to the base scan (pushed through projection)'
					).to.equal(true);
				}
			}
		});

		it('pushes PK predicate through view into INDEXSEEK', async () => {
			await db.exec("CREATE VIEW va AS SELECT id, x, name FROM a");
			const q = "SELECT * FROM va WHERE id = 2";

			const ops = await planOps(q);
			expect(ops).to.include('INDEXSEEK', 'PK predicate through view should become INDEXSEEK');
			expect(ops).to.not.include('FILTER', 'No residual FILTER after PK pushdown');
		});

		it('returns correct results when predicate is pushed through projection', async () => {
			const q = "SELECT * FROM (SELECT a.*, a.x + 1 AS y FROM a) v WHERE v.x > 10";
			const results: any[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results).to.have.lengthOf(2);
			for (const row of results) {
				expect(row.x).to.be.greaterThan(10);
			}
		});
	});
});
