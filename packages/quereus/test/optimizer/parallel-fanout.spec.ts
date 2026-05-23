/**
 * Recognition + cost-gate tests for `ruleFanOutLookupJoin`.
 *
 * Runtime correctness lives in `test/runtime/fanout-lookup-join.spec.ts`; these
 * tests only care about *when* the rule fires and what shape its output takes.
 *
 * The cost gate is anchored on `physical.expectedLatencyMs`, which the
 * synthetic `HighLatencyMemoryModule` below declares non-zero. With no remote
 * plugin in tree the rule is inert by design — the local-only no-rewrite case
 * verifies that.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { SqlValue } from '../../src/common/types.js';

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

/**
 * Memory-backed module that declares a non-zero `expectedLatencyMs`. Used as
 * the lookup table type in multi-branch scenarios so the fan-out cost gate has
 * a real savings number to compare against `branchSetupCost`.
 */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

async function results(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

function hasFanOut(rows: readonly PlanRow[]): boolean {
	return rows.some(r => r.op === 'FANOUTLOOKUPJOIN' || r.node_type === 'FanOutLookupJoin');
}

function joinCount(rows: readonly PlanRow[]): number {
	const JOIN_OPS = new Set([
		'JOIN', 'HASHJOIN', 'MERGEJOIN', 'NESTEDLOOPJOIN', 'BLOOMJOIN', 'ASOFSCAN',
	]);
	return rows.filter(r => JOIN_OPS.has(r.op)).length;
}

describe('ruleFanOutLookupJoin', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Register the high-latency module under a distinct name so tables can
		// opt in via USING.
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
		// Tighten the cap so N=3 branches surface a positive cost gate (default
		// cap=8 ≥ N=3 means `(N - cap) × latency = 0`, which the gate rejects —
		// the rule fires only when concurrency-bound). Each test that needs the
		// default cap behavior restores it inline.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, concurrency: 2 },
		});
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * Three lookup tables (cust, prod, region) and one orders table whose FKs
	 * point at each lookup's PK. `using_lookup` controls whether the lookup
	 * tables are backed by the high-latency module.
	 */
	async function setup3Branches(using_lookup: 'memory' | 'hi_lat_memory'): Promise<void> {
		await db.exec(
			`create table cust (id integer primary key, name text) using ${using_lookup}`,
		);
		await db.exec(
			`create table prod (id integer primary key, sku text) using ${using_lookup}`,
		);
		await db.exec(
			`create table region (id integer primary key, label text) using ${using_lookup}`,
		);
		await db.exec(
			`create table orders (
				order_id integer primary key,
				customer_id integer not null references cust(id),
				product_id integer not null references prod(id),
				region_id integer not null references region(id),
				total real
			) using memory`,
		);
		await db.exec("insert into cust values (1, 'Acme'), (2, 'Beta')");
		await db.exec("insert into prod values (10, 'SKU-A'), (20, 'SKU-B')");
		await db.exec("insert into region values (100, 'EU'), (200, 'US')");
		await db.exec(`insert into orders values
			(1, 1, 10, 100, 99.0),
			(2, 2, 20, 200, 49.5),
			(3, 1, 20, 100, 12.0)`);
	}

	const fanout3SQL =
		`select o.order_id, c.name, p.sku, r.label
		 from orders o
		 left join cust c on o.customer_id = c.id
		 left join prod p on o.product_id = p.id
		 left join region r on o.region_id = r.id`;

	it('does NOT cluster below tuning.parallel.minBranches', async () => {
		// One branch over the high-latency module → below the default minBranches=2.
		await setup3Branches('hi_lat_memory');
		const q = `select o.order_id, c.name from orders o left join cust c on o.customer_id = c.id`;
		const plan = await planRows(db, q);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('clusters when N ≥ minBranches and latency win exceeds setup overhead', async () => {
		await setup3Branches('hi_lat_memory');
		const plan = await planRows(db, fanout3SQL);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);

		// Original 3 joins collapsed into the FanOut → no other join ops survive.
		expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
	});

	it('does NOT cluster on local-only chains regardless of N', async () => {
		// 3 branches over the memory module (expectedLatencyMs=0) — cost gate
		// must reject because (N-cap) × 0 ≤ N × branchSetupCost.
		await setup3Branches('memory');
		const plan = await planRows(db, fanout3SQL);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('does NOT cluster when concurrency cap >= branch count (no parallel win)', async () => {
		await setup3Branches('hi_lat_memory');
		// Cap=10 on 3 branches → (3-3) × 25 = 0 savings vs 3 × 1.0 = 3 overhead.
		// (`beforeEach` lowered the cap to 2 to make the positive-case tests fire;
		// here we restore the default 8 — which is still ≥ N — to verify the gate.)
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, concurrency: 10 },
		});
		try {
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('clusters when N > default concurrency cap', async () => {
		// Use a fresh tuning with the default cap=8, and N=9 to exceed it.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({ ...before, parallel: { ...before.parallel, concurrency: 8 } });
		try {
			// 9 lookup tables, all FK→PK aligned.
			for (let i = 0; i < 9; i++) {
				await db.exec(`create table lk${i} (id integer primary key, v integer) using hi_lat_memory`);
				await db.exec(`insert into lk${i} values (1, ${i * 10}), (2, ${i * 10 + 1})`);
			}
			const cols = Array.from({ length: 9 }, (_, i) =>
				`fk${i} integer not null references lk${i}(id)`).join(', ');
			await db.exec(`create table wide (id integer primary key, ${cols}) using memory`);
			await db.exec(`insert into wide values (1, ${Array(9).fill('1').join(',')})`);
			const joins = Array.from({ length: 9 }, (_, i) =>
				`left join lk${i} on wide.fk${i} = lk${i}.id`).join(' ');
			const sel = `select wide.id, ${Array.from({ length: 9 }, (_, i) => `lk${i}.v as v${i}`).join(', ')} from wide ${joins}`;
			const plan = await planRows(db, sel);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('honors disabledRules and leaves the chain as nested joins', async () => {
		await setup3Branches('hi_lat_memory');
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['fanout-lookup-join']),
		});
		try {
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
			expect(joinCount(plan)).to.be.greaterThan(0);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('does NOT cluster INNER branch with nullable FK', async () => {
		// Lookup is high-latency, but FK is nullable → individual branch fails
		// the same nullability guard `ruleJoinElimination` uses.
		await db.exec(`create table cust (id integer primary key, name text) using hi_lat_memory`);
		await db.exec(`create table prod (id integer primary key, sku text) using hi_lat_memory`);
		await db.exec(`create table region (id integer primary key, label text) using hi_lat_memory`);
		// Two FKs are NOT NULL, one is nullable. Use INNER joins so nullability
		// matters; the nullable-FK branch must fail recognition.
		await db.exec(`create table orders (
			order_id integer primary key,
			customer_id integer not null references cust(id),
			product_id integer not null references prod(id),
			region_id integer null references region(id),
			total real
		) using memory`);
		const q = `select o.order_id, c.name, p.sku, r.label
		           from orders o
		           inner join cust c on o.customer_id = c.id
		           inner join prod p on o.product_id = p.id
		           inner join region r on o.region_id = r.id`;
		const plan = await planRows(db, q);
		// The nullable-region branch breaks the chain → rule must abort.
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('preserves output rows across rewrite (execution equivalence)', async () => {
		await setup3Branches('hi_lat_memory');
		const rewrittenPlan = await planRows(db, fanout3SQL);
		expect(hasFanOut(rewrittenPlan)).to.equal(true);
		const out = await results(db, fanout3SQL + ' order by o.order_id');

		// Now disable the rule and re-run for the baseline.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['fanout-lookup-join']),
		});
		let baseline: Record<string, SqlValue>[];
		try {
			baseline = await results(db, fanout3SQL + ' order by o.order_id');
		} finally {
			db.optimizer.updateTuning(before);
		}

		expect(out).to.deep.equal(baseline);
		expect(out.map(r => r.order_id)).to.deep.equal([1, 2, 3]);
		expect(out.map(r => r.name)).to.deep.equal(['Acme', 'Beta', 'Acme']);
		expect(out.map(r => r.sku)).to.deep.equal(['SKU-A', 'SKU-B', 'SKU-B']);
		expect(out.map(r => r.label)).to.deep.equal(['EU', 'US', 'EU']);
	});

	it('preserves output attribute IDs across the rewrite', async () => {
		await setup3Branches('hi_lat_memory');
		// Wrap the projection in an outer SELECT so we can inspect the inner
		// projection's column names + values — attribute IDs aren't directly
		// exposed in query_plan, but stable column names + values across the
		// rewrite is the user-facing manifestation.
		const before = db.optimizer.tuning;
		const baseline = (() => {
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			try {
				return results(db, fanout3SQL + ' order by o.order_id');
			} finally {
				db.optimizer.updateTuning(before);
			}
		})();
		const rewritten = results(db, fanout3SQL + ' order by o.order_id');
		const [base, rewr] = await Promise.all([baseline, rewritten]);
		expect(Object.keys(base[0])).to.deep.equal(Object.keys(rewr[0]));
	});

	it('honors tuning.parallel.minBranches override', async () => {
		await setup3Branches('hi_lat_memory');
		// Tighten the threshold so 3 branches still qualifies; loosen the cap so
		// (N - cap) × latency is positive.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, minBranches: 4 },
		});
		try {
			// 3 < 4 → no cluster even with high-latency module.
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});
});
