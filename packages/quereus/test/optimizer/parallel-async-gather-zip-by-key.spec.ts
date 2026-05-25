/**
 * Recognition + cost-gate + execution tests for `ruleAsyncGatherZipByKey`.
 *
 * The rule folds a `Project` over a chain of binary full-outer `JoinNode`s
 * sharing a common key set into a single `AsyncGatherNode(zipByKey)`. The cost
 * gate is anchored on `physical.expectedLatencyMs` (0 on memory-vtab paths,
 * non-zero for the synthetic `HighLatencyMemoryModule`), so memory-only plans
 * never trigger the rewrite.
 *
 * Note: binary FULL JOIN has no runtime lowering — the gather rewrite is its
 * ONLY execution path. So the execution tests below assert results directly
 * (there is no rule-disabled baseline to diff against; disabling the rule makes
 * the same query throw `FULL JOIN is not supported`).
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { SqlValue } from '../../src/common/types.js';

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
}

class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval('SELECT node_type, op, detail FROM query_plan(?)', [sql])) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

async function results(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

function hasAsyncGather(rows: readonly PlanRow[]): boolean {
	return rows.some(r => r.op === 'ASYNCGATHER' || r.node_type === 'AsyncGather');
}

function countOp(rows: readonly PlanRow[], op: string, nodeType: string): number {
	return rows.filter(r => r.op === op || r.node_type === nodeType).length;
}

function sortByK(rows: Record<string, SqlValue>[]): Record<string, SqlValue>[] {
	return [...rows].sort((a, b) => Number(a.k ?? -1) - Number(b.k ?? -1));
}

describe('ruleAsyncGatherZipByKey', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * Three high-latency tables a/b/c with a shared integer key `k` and one
	 * non-key column each. Keys overlap partially so the full-outer merge
	 * exercises present/absent branches per key.
	 */
	async function setup(): Promise<void> {
		await db.exec('create table a (k integer primary key, av text) using hi_lat_memory');
		await db.exec('create table b (k integer primary key, bv text) using hi_lat_memory');
		await db.exec('create table c (k integer primary key, cv text) using hi_lat_memory');
		await db.exec("insert into a values (1,'a1'),(2,'a2')");
		await db.exec("insert into b values (2,'b2'),(3,'b3')");
		await db.exec("insert into c values (1,'c1'),(3,'c3')");
	}

	const zip3SQL =
		`select coalesce(a.k, b.k, c.k) as k, a.av, b.bv, c.cv
		   from a full outer join b on a.k = b.k
		          full outer join c on a.k = c.k`;

	it('folds a 3-branch full-outer chain into one AsyncGather(zipByKey)', async () => {
		await setup();
		const plan = await planRows(db, zip3SQL);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		// The whole recognized subtree collapses: no Join, no Project survive.
		expect(countOp(plan, 'JOIN', 'Join'), 'all full joins folded').to.equal(0);
		expect(countOp(plan, 'PROJECT', 'Project'), 'project folded into gather').to.equal(0);
		// Exactly one gather (idempotence — re-firing finds no ProjectNode).
		expect(countOp(plan, 'ASYNCGATHER', 'AsyncGather')).to.equal(1);
	});

	it('produces correct full-outer merge results', async () => {
		await setup();
		const rows = sortByK(await results(db, zip3SQL));
		expect(rows).to.deep.equal([
			{ k: 1, av: 'a1', bv: null, cv: 'c1' },
			{ k: 2, av: 'a2', bv: 'b2', cv: null },
			{ k: 3, av: null, bv: 'b3', cv: 'c3' },
		]);
	});

	it('folds a 2-branch full-outer pair', async () => {
		await setup();
		const sql =
			`select coalesce(a.k, b.k) as k, a.av, b.bv
			   from a full outer join b on a.k = b.k`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
	});

	it('folds a composite (K=2) shared key', async () => {
		await db.exec('create table p (k1 integer, k2 integer, pv text, primary key (k1, k2)) using hi_lat_memory');
		await db.exec('create table q (k1 integer, k2 integer, qv text, primary key (k1, k2)) using hi_lat_memory');
		await db.exec("insert into p values (1,1,'p11'),(1,2,'p12')");
		await db.exec("insert into q values (1,2,'q12'),(2,2,'q22')");
		const sql =
			`select coalesce(p.k1, q.k1) as k1, coalesce(p.k2, q.k2) as k2, p.pv, q.qv
			   from p full outer join q on p.k1 = q.k1 and p.k2 = q.k2`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		const rows = await results(db, sql);
		const norm = rows.map(r => `${r.k1},${r.k2},${r.pv ?? '-'},${r.qv ?? '-'}`).sort();
		expect(norm).to.deep.equal([
			'1,1,p11,-',
			'1,2,p12,q12',
			'2,2,-,q22',
		]);
	});

	it('does NOT fold a purely local-only (memory) chain', async () => {
		await db.exec('create table la (k integer primary key, av text) using memory');
		await db.exec('create table lb (k integer primary key, bv text) using memory');
		const sql =
			`select coalesce(la.k, lb.k) as k, la.av, lb.bv
			   from la full outer join lb on la.k = lb.k`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('does NOT fold when threshold is raised above the slowest branch', async () => {
		await setup();
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, gatherThresholdMs: 1000 },
		});
		try {
			const plan = await planRows(db, zip3SQL);
			expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('does NOT fold below tuning.parallel.minBranches', async () => {
		await setup();
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, minBranches: 4 },
		});
		try {
			const plan = await planRows(db, zip3SQL);
			expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('honors disabledRules', async () => {
		await setup();
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['async-gather-zip-by-key']),
		});
		try {
			const plan = await planRows(db, zip3SQL);
			expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('does NOT fold when an ON condition carries a residual (non-key) predicate', async () => {
		await setup();
		const sql =
			`select coalesce(a.k, b.k, c.k) as k, a.av, b.bv, c.cv
			   from a full outer join b on a.k = b.k and a.av = b.bv
			          full outer join c on a.k = c.k`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('does NOT fold when a branch is absent from the shared key set', async () => {
		// c joins on a non-key column, so the key groups are {a.k,b.k} (missing c)
		// and {a.av,c.cv} (missing b) — neither is shared across all branches.
		await setup();
		const sql =
			`select coalesce(a.k, b.k) as k, a.av, b.bv, c.cv
			   from a full outer join b on a.k = b.k
			          full outer join c on a.av = c.cv`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('does NOT fold when a branch is not key-unique on the equated key column', async () => {
		// na/nb have no declared unique key on `k`, so the zip's one-row-per-key
		// merge would diverge from a true full join's per-key product. Block.
		await db.exec('create table na (k integer, av text) using hi_lat_memory');
		await db.exec('create table nb (k integer, bv text) using hi_lat_memory');
		await db.exec("insert into na values (1,'a1'),(1,'a1dup')");
		await db.exec("insert into nb values (1,'b1')");
		const sql =
			`select coalesce(na.k, nb.k) as k, na.av, nb.bv
			   from na full outer join nb on na.k = nb.k`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('does NOT fold when a key column uses a non-binary collation', async () => {
		// Both branches agree on NOCASE, but the emitter's merged-key value is
		// whichever branch arrived first (non-deterministic) and can diverge from
		// coalesce's left-to-right pick when collation-equal keys are byte-distinct
		// ('A'/'a'). v1 gates non-binary key collations out entirely.
		await db.exec('create table ca (k text primary key collate NOCASE, av text) using hi_lat_memory');
		await db.exec('create table cb (k text primary key collate NOCASE, bv text) using hi_lat_memory');
		await db.exec("insert into ca values ('x','a1')");
		await db.exec("insert into cb values ('x','b1')");
		const sql =
			`select coalesce(ca.k, cb.k) as k, ca.av, cb.bv
			   from ca full outer join cb on ca.k = cb.k`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('still folds when key columns are explicitly binary', async () => {
		// Sanity: the binary-collation gate does not reject the common case.
		await db.exec('create table ba (k text primary key collate BINARY, av text) using hi_lat_memory');
		await db.exec('create table bb (k text primary key collate BINARY, bv text) using hi_lat_memory');
		await db.exec("insert into ba values ('x','a1')");
		await db.exec("insert into bb values ('y','b1')");
		const sql =
			`select coalesce(ba.k, bb.k) as k, ba.av, bb.bv
			   from ba full outer join bb on ba.k = bb.k`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
	});

	it('does NOT fold when the key projection is not a coalesce over all branches', async () => {
		// `a.k` alone (not coalesced) would mis-merge: a row present only in b/c
		// would surface NULL for the key. The rule must decline to preserve
		// semantics; only the coalesced merged key is a valid zipByKey output.
		await setup();
		const sql =
			`select a.k as k, a.av, b.bv, c.cv
			   from a full outer join b on a.k = b.k
			          full outer join c on a.k = c.k`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});
});
