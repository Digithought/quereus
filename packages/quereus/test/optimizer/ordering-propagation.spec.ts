import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Ordering propagation', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')");
	}

	it('Project remaps ordering column indices through projection reordering', async () => {
		await setup();

		const sql = "SELECT v, id FROM (SELECT id, v FROM t ORDER BY id) s";
		const rows: Array<{ physical: string | null; detail: string }> = [];
		for await (const r of db.eval("SELECT physical, detail FROM query_plan(?) WHERE op = 'PROJECT'", [sql])) {
			rows.push(r as any);
		}

		const outer = rows.find(r => String(r.detail).includes('SELECT v, id'));
		expect(outer, 'expected outer PROJECT node to be present').to.not.equal(undefined);
		expect(outer!.physical).to.be.a('string');

		const physical = JSON.parse(String(outer!.physical));
		expect(physical).to.have.property('ordering');
		expect(physical.ordering).to.deep.equal([{ column: 1, desc: false }]);
	});

	it('Streaming aggregate does not insert redundant sort when source already ordered by grouping keys', async () => {
		await setup();

		const sql = "SELECT id, count(*) AS c FROM (SELECT * FROM t ORDER BY id LIMIT ?) s GROUP BY id";
		const sorts: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as any);
		}

		const streamAggs: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'STREAMAGGREGATE'", [sql])) {
			streamAggs.push(r as any);
		}

		expect(streamAggs).to.have.lengthOf(1);
		expect(streamAggs[0].c).to.equal(1);

		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c).to.equal(0);
	});
});

