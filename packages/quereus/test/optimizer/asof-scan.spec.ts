import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';

interface PlanRow { node_type: string; op: string; detail: string; properties: string | null; physical: string | null }

interface MonotonicOnEntry { attrId: number; strict: boolean; direction: 'asc' | 'desc' }
interface PhysicalProps {
	monotonicOn?: MonotonicOnEntry[];
	ordering?: { column: number; desc: boolean }[];
}

interface AsofProps {
	outer: boolean;
	strict: boolean;
	direction: 'asc' | 'desc';
	matchAttr: { left: number; right: number };
	partitionAttrs: { left: number; right: number }[];
	rightOutputColumnIndices?: number[];
}

async function getPlanRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		"SELECT node_type, op, detail, properties, physical FROM query_plan(?)", [sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function findOp(rows: PlanRow[], op: string): PlanRow | undefined {
	return rows.find(r => r.op === op);
}

function asofPropsOf(rows: PlanRow[]): AsofProps | undefined {
	const row = findOp(rows, 'ASOFSCAN');
	if (!row || !row.properties) return undefined;
	return JSON.parse(row.properties) as AsofProps;
}

function physicalOf(rows: PlanRow[], op: string): PhysicalProps | undefined {
	const row = findOp(rows, op);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

describe('AsofScan rule (lateral-top-1 → AsofScanNode)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Trades + quotes — quotes has (symbol, ts) PK so the memory module
		// advertises monotonicOn(symbol) on the leading PK column for full scan,
		// but the asof match is on `ts`, so we rely on a single-column ordering.
		await db.exec("CREATE TABLE trades (id INTEGER PRIMARY KEY, symbol TEXT, ts INTEGER) USING memory");
		await db.exec("CREATE TABLE quotes (ts INTEGER PRIMARY KEY, symbol TEXT, bid REAL, ask REAL) USING memory");
		await db.exec("INSERT INTO trades VALUES (1,'A',100),(2,'A',200),(3,'B',150)");
		await db.exec("INSERT INTO quotes VALUES (50,'A',1.0,1.1),(150,'A',1.5,1.6),(180,'B',2.0,2.1),(250,'A',2.5,2.6)");
	});
	afterEach(async () => { await db.close(); });

	it('recognizes a simple non-strict left lateral-top-1 with no partition', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.ts <= t.ts order by q.ts desc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		const asof = asofPropsOf(rows);
		expect(asof, 'AsofScan node present').to.not.equal(undefined);
		expect(asof!.outer).to.equal(true);
		expect(asof!.strict).to.equal(false);
		expect(asof!.direction).to.equal('desc');
		expect(asof!.partitionAttrs).to.be.an('array').with.lengthOf(0);
	});

	it('recognizes the ASC variant (q.ts >= t.ts order by q.ts asc) — earliest right ≥ left', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts >= t.ts order by q.ts asc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		const asof = asofPropsOf(rows);
		expect(asof, 'AsofScan node present').to.not.equal(undefined);
		expect(asof!.direction).to.equal('asc');
		expect(asof!.strict).to.equal(false);
		expect(asof!.partitionAttrs).to.be.an('array').with.lengthOf(1);
	});

	it('recognizes the strict ASC variant (q.ts > t.ts order by q.ts asc)', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts > t.ts order by q.ts asc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		const asof = asofPropsOf(rows);
		expect(asof, 'AsofScan node present').to.not.equal(undefined);
		expect(asof!.direction).to.equal('asc');
		expect(asof!.strict).to.equal(true);
	});

	it('does not fire when sort direction disagrees with the predicate (q.ts <= t.ts but order by asc)', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts order by q.ts asc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		expect(findOp(rows, 'ASOFSCAN'), 'no asof scan when sort/predicate directions disagree').to.equal(undefined);
	});

	it('does not fire when sort direction disagrees with the predicate (q.ts >= t.ts but order by desc)', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts >= t.ts order by q.ts desc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		expect(findOp(rows, 'ASOFSCAN'), 'no asof scan when sort/predicate directions disagree').to.equal(undefined);
	});

	it('recognizes a partitioned non-strict left lateral-top-1', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts order by q.ts desc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		const asof = asofPropsOf(rows);
		expect(asof, 'AsofScan node present').to.not.equal(undefined);
		expect(asof!.outer).to.equal(true);
		expect(asof!.strict).to.equal(false);
		expect(asof!.partitionAttrs).to.be.an('array').with.lengthOf(1);
	});

	it('recognizes the strict variant (q.ts < t.ts)', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts < t.ts order by q.ts desc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		const asof = asofPropsOf(rows);
		expect(asof, 'AsofScan node present').to.not.equal(undefined);
		expect(asof!.strict).to.equal(true);
	});

	it('recognizes inner cross join lateral as outer=false', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t cross join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts order by q.ts desc limit 1
		) q`;
		const rows = await getPlanRows(db, sql);
		const asof = asofPropsOf(rows);
		expect(asof, 'AsofScan node present').to.not.equal(undefined);
		expect(asof!.outer).to.equal(false);
	});

	it('does not fire on LIMIT 2', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts order by q.ts desc limit 2
		) q on true`;
		const rows = await getPlanRows(db, sql);
		expect(findOp(rows, 'ASOFSCAN'), 'no asof scan').to.equal(undefined);
	});

	it('does not fire on LIMIT 1 OFFSET 1', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts order by q.ts desc limit 1 offset 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		expect(findOp(rows, 'ASOFSCAN'), 'no asof scan with offset').to.equal(undefined);
	});

	it('does not fire on a non-trivial sort key (q.ts + 1)', async () => {
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts order by q.ts + 1 desc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		expect(findOp(rows, 'ASOFSCAN'), 'no asof scan with non-trivial sort').to.equal(undefined);
	});

	it('does not fire when an extra unrelated predicate appears', async () => {
		// Add a non-correlated scalar predicate that won't push down trivially.
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts and q.bid > t.ts order by q.ts desc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		// Multi-asof predicates (q.ts <= t.ts and q.bid > t.ts) should bail.
		expect(findOp(rows, 'ASOFSCAN'), 'no asof scan with multi inequalities').to.equal(undefined);
	});

	it('AsofScan inherits left ordering as its monotonicOn', async () => {
		const sql = `select t.id, q.bid from (select * from trades order by ts) t
			left join lateral (
				select bid from quotes q where q.ts <= t.ts order by q.ts desc limit 1
			) q on true`;
		const rows = await getPlanRows(db, sql);
		const asof = findOp(rows, 'ASOFSCAN');
		expect(asof, 'asof scan present').to.not.equal(undefined);
		const physical = physicalOf(rows, 'ASOFSCAN');
		expect(physical, 'asof physical').to.not.equal(undefined);
		// Ordering should be inherited from the left subtree.
		expect(physical!.ordering, 'ordering inherited from left').to.be.an('array');
	});

	it('rule-disabled tuning falls back to the existing join path', async () => {
		const tuning = { ...DEFAULT_TUNING, disabledRules: new Set(['lateral-top1-asof']) };
		db.optimizer.updateTuning(tuning);
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts order by q.ts desc limit 1
		) q on true`;
		const rows = await getPlanRows(db, sql);
		expect(findOp(rows, 'ASOFSCAN'), 'no asof scan when disabled').to.equal(undefined);
	});
});
