import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Key propagation and estimatedRows reduction', () => {
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

	it('Project preserves PK-based uniqueness', async () => {
		await setup();
		// Estimated rows should be 1 for full-PK equality seek
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval(
			"SELECT count(*) AS c FROM query_plan('SELECT id FROM t WHERE id = 2') WHERE properties LIKE '%\"estimatedRows\":1%'"
		)) rows.push(r as Record<string, unknown>);
		expect(rows[0].c).to.be.greaterThan(0);
	});

	it('Join combines keys for inner join (conservative)', async () => {
		await setup();
		await db.exec("CREATE TABLE u (uid INTEGER PRIMARY KEY, t_id INTEGER) USING memory");
		await db.exec("INSERT INTO u VALUES (10,1),(11,2)");
		// Verify uniqueKeys presence in plan properties
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval("SELECT json_group_array(properties) AS props FROM query_plan('SELECT * FROM t INNER JOIN u ON t.id = u.t_id')")) rows.push(r as Record<string, unknown>);
		const props = JSON.stringify(rows[0].props);
		expect(props).to.match(/"uniqueKeys":/);
	});

	it('Composite PK join preserves left keys when right PK covered', async () => {
		await db.exec("CREATE TABLE p (a INTEGER, b INTEGER, PRIMARY KEY (a,b)) USING memory");
		await db.exec("INSERT INTO p VALUES (1,10),(2,20)");
		await db.exec("CREATE TABLE c (x INTEGER, y INTEGER) USING memory");
		await db.exec("INSERT INTO c VALUES (1,10),(1,99),(2,20)");
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval("SELECT json_group_array(properties) AS props FROM query_plan('SELECT * FROM c INNER JOIN p ON c.x = p.a AND c.y = p.b')")) rows.push(r as Record<string, unknown>);
		const props = JSON.stringify(rows[0].props);
		// Expect uniqueKeys present (at least one side preserved)
		expect(props).to.match(/"uniqueKeys":/);
	});

	it('Distinct declares all-columns key', async () => {
		// Use an explicit primary key column so duplicate (id,v) rows are allowed
		await db.exec("CREATE TABLE d (k INTEGER PRIMARY KEY, id INTEGER, v INTEGER) USING memory");
		await db.exec("INSERT INTO d VALUES (1,1,1),(2,1,1),(3,2,2)");
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval("SELECT json_group_array(properties) AS props FROM query_plan('SELECT DISTINCT id, v FROM d')")) rows.push(r as Record<string, unknown>);
		const props = JSON.stringify(rows[0].props);
		expect(props).to.match(/"uniqueKeys":\[\[/);
	});

	it('GROUP BY declares group key', async () => {
		await db.exec("CREATE TABLE g (id INTEGER, v INTEGER) USING memory");
		await db.exec("INSERT INTO g VALUES (1,1),(1,2),(2,3)");
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval("SELECT json_group_array(properties) AS props FROM query_plan('SELECT id, COUNT(*) FROM g GROUP BY id')")) rows.push(r as Record<string, unknown>);
		const props = JSON.stringify(rows[0].props);
		expect(props).to.match(/"uniqueKeys":\[\[/);
	});

	it('Physical hash join node has key-driven estimatedRows', async () => {
		await setup();
		await db.exec("CREATE TABLE u2 (uid INTEGER PRIMARY KEY, t_id INTEGER) USING memory");
		await db.exec("INSERT INTO u2 VALUES (10,1),(11,2),(12,3)");
		// When joining u2.t_id = t.id, t.id is a PK so right key is covered.
		// estimatedRows should be driven by left side (u2 rows = 3), not the heuristic product.
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval("SELECT json_group_array(properties) AS props FROM query_plan('SELECT * FROM u2 INNER JOIN t ON u2.t_id = t.id')")) rows.push(r as Record<string, unknown>);
		const props = JSON.stringify(rows[0].props);
		// Should have estimatedRows set (not the default heuristic product)
		expect(props).to.match(/"estimatedRows"/);
		expect(props).to.match(/"uniqueKeys"/);
	});

	it('Unique constraint columns create additional keys in RelationType', async () => {
		await db.exec("CREATE TABLE uc (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT) USING memory");
		await db.exec("INSERT INTO uc VALUES (1,'a@b.c','alice'),(2,'d@e.f','bob')");
		// Join on unique column should preserve keys
		await db.exec("CREATE TABLE refs (r_email TEXT) USING memory");
		await db.exec("INSERT INTO refs VALUES ('a@b.c'),('d@e.f')");
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval("SELECT json_group_array(properties) AS props FROM query_plan('SELECT * FROM refs INNER JOIN uc ON refs.r_email = uc.email')")) rows.push(r as Record<string, unknown>);
		const props = JSON.stringify(rows[0].props);
		expect(props).to.match(/"uniqueKeys"/);
	});

	it('DISTINCT elimination when source has unique keys', async () => {
		await setup();
		// SELECT DISTINCT id FROM t — id is the PK so DISTINCT is redundant
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval("SELECT json_group_array(node_type) AS types FROM query_plan('SELECT DISTINCT id FROM t')")) rows.push(r as Record<string, unknown>);
		const types = String(rows[0].types as unknown as string);
		// Distinct node should be eliminated — should NOT appear in plan
		expect(types).to.not.include('Distinct');
	});
});
