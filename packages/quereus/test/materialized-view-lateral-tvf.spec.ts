import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { createTableValuedFunction } from '../src/func/registration.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../src/types/builtin-types.js';
import type { Row, SqlValue } from '../src/common/types.js';

/**
 * White-box coverage for incremental maintenance of an `on-commit-incremental`
 * materialized view whose body fans a base row out through a *lateral table-valued
 * function* (`base t cross join lateral json_each(t.arr)`). A single base-row
 * change maps to MANY backing rows; the per-binding exact `delete-key` cannot
 * express that, so the maintainer uses a base-PK **prefix delete** + re-insert —
 * but only when the TVF's `relationalAdvertisement` proves the recomputed fan-out
 * is a set on the backing PK. Otherwise it falls back to a full rebuild.
 *
 * The `.sqllogic` suite (52-materialized-views-incremental, lateral-TVF section)
 * asserts the *results* against the hand-computed full-rebuild oracle. These
 * tests additionally prove *which path* ran, via the fault-injection seam, and
 * cross-check the incremental MV against a parallel `manual` MV.
 */
describe('Incremental materialized view — lateral TVF fan-out', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function selectAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push(row);
		return rows;
	}

	function diverged(name: string): boolean | undefined {
		return db.schemaManager.getMaterializedView('main', name)?.diverged;
	}

	/**
	 * The prefix-delete path runs `runResidual` (fires the `'residual'` fault) and
	 * recovers via `recoveryRebuild` (fires the `'rebuild'` fault); a direct
	 * rebuild calls `rebuildBacking` and fires neither. So under a residual+rebuild
	 * fault, a gate-passing (incremental) MV diverges while a gate-failing
	 * (rebuild) MV does not — a clean witness of which path executed.
	 */
	it('takes the bounded prefix-delete path only when the advertisement gate passes', async () => {
		await db.exec(`create table doc (id integer primary key, arr text)`);
		await db.exec(`insert into doc values (1, '[10,20]'), (2, '[30]')`);
		// Gate PASSES: json_each advertises a key on column 4 (je.id); projecting it
		// into the backing PK makes the backing-PK TVF portion a superkey.
		await db.exec(`create materialized view mv_pass as
			select d.id as id, je.id as eid, je.value as v
			from doc d cross join lateral json_each(d.arr) je
			with refresh = 'on-commit-incremental'`);
		// Gate FAILS: only je.value is projected, so the backing PK carries no
		// advertised TVF key — the fan-out cannot be proven a set ⇒ full rebuild.
		await db.exec(`create materialized view mv_fail as
			select d.id as id, je.value as v
			from doc d cross join lateral json_each(d.arr) je
			with refresh = 'on-commit-incremental'`);

		db._setMaterializedViewMaintenanceFault((phase) => {
			if (phase === 'residual' || phase === 'rebuild') throw new Error(`injected ${phase}`);
		});

		await db.exec(`update doc set arr = '[40,50,60]' where id = 1`);

		expect(diverged('mv_pass'), 'gate-pass MV took the residual (incremental) path').to.equal(true);
		expect(diverged('mv_fail'), 'gate-fail MV rebuilt directly (no residual)').to.not.equal(true);
	});

	/**
	 * Incremental result == full-rebuild oracle across insert / delete / arity-
	 * changing update. The `manual` MV is the oracle (refresh = full recompute);
	 * the incremental MV must converge to the identical set every commit.
	 */
	it('matches the manual full-rebuild oracle across insert/delete/arity-change', async () => {
		await db.exec(`create table doc (id integer primary key, arr text)`);
		await db.exec(`insert into doc values (1, '[10,20,30]'), (2, '[40]'), (3, '[50,60]')`);
		const body = `select d.id as id, je.id as eid, je.value as v
			from doc d cross join lateral json_each(d.arr) je`;
		await db.exec(`create materialized view mv_inc as ${body} with refresh = 'on-commit-incremental'`);
		await db.exec(`create materialized view mv_man as ${body}`);

		const assertConverged = async (): Promise<void> => {
			await db.exec(`refresh materialized view mv_man`);
			const inc = await selectAll(`select id, eid, v from mv_inc order by id, eid`);
			const man = await selectAll(`select id, eid, v from mv_man order by id, eid`);
			expect(inc).to.deep.equal(man);
		};

		await assertConverged();
		// INSERT — new base row's whole fan-out appears.
		await db.exec(`insert into doc values (4, '[70,80,90]')`);
		await assertConverged();
		// DELETE — the prefix delete removes ALL of base row 1's fan-out.
		await db.exec(`delete from doc where id = 1`);
		await assertConverged();
		// Arity-shrinking update (3 → 2).
		await db.exec(`update doc set arr = '[7,8]' where id = 4`);
		await assertConverged();
		// Arity-growing update (1 → 4) — the case the exact delete-key could not do.
		await db.exec(`update doc set arr = '[1,2,3,4]' where id = 2`);
		await assertConverged();

		const final = await selectAll(`select id, eid, v from mv_inc order by id, eid`);
		expect(final).to.deep.equal([
			{ id: 2, eid: 0, v: 1 }, { id: 2, eid: 1, v: 2 }, { id: 2, eid: 2, v: 3 }, { id: 2, eid: 3, v: 4 },
			{ id: 3, eid: 0, v: 50 }, { id: 3, eid: 1, v: 60 },
			{ id: 4, eid: 0, v: 7 }, { id: 4, eid: 1, v: 8 },
		]);
	});

	/**
	 * Set-ness gate via the `isSet` route (rather than an advertised `keys` entry).
	 * `split_parts` advertises `isSet` only; projecting *all* its output columns
	 * into the backing PK makes that all-columns set the superkey the gate needs.
	 * Verifies both the incremental path runs (fault-injection witness) and the
	 * result matches the oracle across an arity-changing update.
	 */
	it('discharges the set-ness gate via isSet when all TVF columns are in the backing PK', async () => {
		const splitParts = createTableValuedFunction(
			{
				name: 'split_parts',
				numArgs: 1,
				deterministic: true,
				returnType: {
					typeClass: 'relation',
					isReadOnly: true,
					isSet: false,
					columns: [
						{ name: 'idx', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
						{ name: 'part', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
					],
					keys: [],
					rowConstraints: [],
				},
				// isSet only — NO `keys`. The gate must take the isSet route.
				relationalAdvertisement: { isSet: true, deterministic: true },
			},
			async function* (csv: SqlValue): AsyncIterable<Row> {
				const s = typeof csv === 'string' ? csv : String(csv ?? '');
				const parts = s.length === 0 ? [] : s.split(',');
				for (let i = 0; i < parts.length; i++) yield [i, parts[i]];
			},
		);
		db.registerFunction(splitParts);

		await db.exec(`create table src (id integer primary key, csv text)`);
		await db.exec(`insert into src values (1, 'a,b,c'), (2, 'd')`);
		// Project BOTH TVF columns (idx, part) into the backing PK so the isSet
		// all-columns superkey discharges the gate.
		const body = `select s.id as id, sp.idx as idx, sp.part as part
			from src s cross join lateral split_parts(s.csv) sp`;
		await db.exec(`create materialized view mv_sp as ${body} with refresh = 'on-commit-incremental'`);
		await db.exec(`create materialized view mv_sp_man as ${body}`);

		expect(await selectAll(`select id, idx, part from mv_sp order by id, idx`)).to.deep.equal([
			{ id: 1, idx: 0, part: 'a' }, { id: 1, idx: 1, part: 'b' }, { id: 1, idx: 2, part: 'c' },
			{ id: 2, idx: 0, part: 'd' },
		]);

		// Witness the incremental path: under residual+rebuild fault the gate-passing
		// MV diverges (it took the residual path), proving it did not full-rebuild.
		db._setMaterializedViewMaintenanceFault((phase) => {
			if (phase === 'residual' || phase === 'rebuild') throw new Error(`injected ${phase}`);
		});
		await db.exec(`update src set csv = 'x,y' where id = 1`); // arity 3 → 2
		expect(diverged('mv_sp'), 'isSet-route MV took the incremental prefix-delete path').to.equal(true);
		db._setMaterializedViewMaintenanceFault(undefined);

		// Clear divergence and confirm the result matches the full-rebuild oracle.
		await db.exec(`refresh materialized view mv_sp`);
		await db.exec(`refresh materialized view mv_sp_man`);
		const inc = await selectAll(`select id, idx, part from mv_sp order by id, idx`);
		const man = await selectAll(`select id, idx, part from mv_sp_man order by id, idx`);
		expect(inc).to.deep.equal(man);
		expect(inc).to.deep.equal([
			{ id: 1, idx: 0, part: 'x' }, { id: 1, idx: 1, part: 'y' },
			{ id: 2, idx: 0, part: 'd' },
		]);
	});
});
