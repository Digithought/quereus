/**
 * Covering structures — coverage prover + constraint↔structure linkage +
 * introspection hiding (ticket `covering-structure-unique-enforcement`).
 *
 * The implicit-reframe regression floor (observation-equivalence of UNIQUE
 * enforcement) is guarded by the existing UNIQUE suites in test/logic/ and
 * quereus-store; this file owns the new analysis + bookkeeping surface.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { proveCoverage, proveEffectiveKeyUnique, type CoverageResult } from '../src/planner/analysis/coverage-prover.js';
import type { FunctionalDependency, PhysicalProperties, RelationalPlanNode } from '../src/planner/nodes/plan-node.js';
import type { ColRef, RelationType } from '../src/common/datatype.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';

async function freshDb(ddl: string[]): Promise<Database> {
	const db = new Database();
	for (const stmt of ddl) await db.exec(stmt);
	return db;
}

function bodyRoot(db: Database, bodySql: string): RelationalPlanNode {
	const root = db.getPlan(bodySql).getRelations()[0];
	expect(root, 'body produced a relation').to.not.be.undefined;
	return root as RelationalPlanNode;
}

/**
 * Creates the MV, then runs the prover directly against the named UNIQUE
 * constraint on the named base table so per-reason outcomes are observable.
 */
async function prove(
	db: Database,
	mvName: string,
	bodySql: string,
	tableName: string,
	ucIndex = 0,
): Promise<CoverageResult> {
	const mv = db.schemaManager.getMaterializedView('main', mvName);
	expect(mv, 'MV registered').to.not.be.undefined;
	const table = db.schemaManager.getTable('main', tableName)!;
	const uc = table.uniqueConstraints![ucIndex];
	return proveCoverage(bodyRoot(db, bodySql), mv!, uc, table);
}

describe('coverage prover — positive', () => {
	it('select uc-cols + pk ordered by uc-cols covers a composite UNIQUE', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix as select x, y, id from t order by x, y',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, y, id from t order by x, y', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});

	it('covers regardless of ORDER BY permutation of the uc columns', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix as select x, y, id from t order by y, x',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, y, id from t order by y, x', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});

	it('covers a nullable single-column UNIQUE when the body skips NULLs', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null, unique (x))',
			'create materialized view ix as select x, id from t where x is not null order by x',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, id from t where x is not null order by x', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});
});

describe('coverage prover — negative (one per reason)', () => {
	async function expectReason(
		ddl: string[],
		mvName: string,
		bodySql: string,
		tableName: string,
		reason: string,
	): Promise<void> {
		const db = await freshDb(ddl);
		try {
			const result = await prove(db, mvName, bodySql, tableName);
			expect(result.covers, `expected NotCovers(${reason})`).to.be.false;
			if (!result.covers) expect(result.reason).to.equal(reason);
		} finally {
			await db.close();
		}
	}

	it('missing-uc-column', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, id from t order by x',
			],
			'ix', 'select x, id from t order by x', 't', 'missing-uc-column',
		);
	});

	it('missing-pk-column', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y from t order by x, y',
			],
			'ix', 'select x, y from t order by x, y', 't', 'missing-pk-column',
		);
	});

	it('ordering-mismatch (no ORDER BY)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t',
			],
			'ix', 'select x, y, id from t', 't', 'ordering-mismatch',
		);
	});

	it('ordering-mismatch (partial ordering)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x',
			],
			'ix', 'select x, y, id from t order by x', 't', 'ordering-mismatch',
		);
	});

	it('predicate-entailment (body scope wider than partial-UNIQUE scope)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null)',
				'create unique index uq on t (x, y) where x > 5',
				'create materialized view ix as select x, y, id from t where x > 0 order by x, y',
			],
			'ix', 'select x, y, id from t where x > 0 order by x, y', 't', 'predicate-entailment',
		);
	});

	it('predicate-entailment (full UNIQUE but body restricts rows)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t where x > 0 order by x, y',
			],
			'ix', 'select x, y, id from t where x > 0 order by x, y', 't', 'predicate-entailment',
		);
	});

	it('missing-null-skip (nullable uc column, no NULL filter)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer null, unique (x))',
				'create materialized view ix as select x, id from t order by x',
			],
			'ix', 'select x, id from t order by x', 't', 'missing-null-skip',
		);
	});

	it('shape (join body is not a single-table chain)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create table u (uid integer primary key, x integer not null)',
				'create materialized view ix as select t.x, t.y, t.id from t join u on t.x = u.x order by t.x, t.y',
			],
			'ix', 'select t.x, t.y, t.id from t join u on t.x = u.x order by t.x, t.y', 't', 'shape',
		);
	});

	it('shape (LIMIT materializes only a prefix — never covers)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x, y limit 100',
			],
			'ix', 'select x, y, id from t order by x, y limit 100', 't', 'shape',
		);
	});

	it('shape (OFFSET drops governed rows — never covers)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x, y limit 100 offset 10',
			],
			'ix', 'select x, y, id from t order by x, y limit 100 offset 10', 't', 'shape',
		);
	});
});

describe('eager prove-and-link', () => {
	it('populates coveringStructureName + covers on create, clears on drop', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix_t_xy as select x, y, id from t order by x, y',
		]);
		try {
			const uc = () => db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
			expect(uc().coveringStructureName, 'forward pointer set').to.equal('ix_t_xy');

			const mv = db.schemaManager.getMaterializedView('main', 'ix_t_xy')!;
			expect(mv.origin).to.equal('explicit');
			expect(mv.covers).to.deep.include({ schemaName: 'main', tableName: 't' });

			await db.exec('drop materialized view ix_t_xy');
			expect(uc().coveringStructureName, 'forward pointer cleared on drop').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('does NOT link a non-covering MV', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			// No ORDER BY ⇒ not a covering structure.
			'create materialized view ix as select x, y, id from t',
		]);
		try {
			expect(db.schemaManager.getTable('main', 't')!.uniqueConstraints![0].coveringStructureName).to.be.undefined;
			expect(db.schemaManager.getMaterializedView('main', 'ix')!.covers).to.be.undefined;
		} finally {
			await db.close();
		}
	});
});

describe('introspection hiding', () => {
	it('omits the implicit covering structure by default', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, constraint uq unique (x))',
		]);
		try {
			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.indexes.find(i => i.tableName === 't'), 'no implicit index surfaced').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('surfaces it when the constraint carries quereus.expose_implicit_index = true', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, constraint uq unique (x) with tags ("quereus.expose_implicit_index" = true))',
		]);
		try {
			const catalog = collectSchemaCatalog(db, 'main');
			const idx = catalog.indexes.find(i => i.tableName === 't' && i.name === 'uq');
			expect(idx, 'implicit index surfaced under the constraint name').to.not.be.undefined;
		} finally {
			await db.close();
		}
	});
});

/**
 * Effective-key ("body proves it") prover — proves the body's own *output*
 * relation is unique on the declared key columns via its effective key (FD
 * closure), the obligation primitive the lens prover's `obligation: proved`
 * class consumes. Distinct from base-table `proveCoverage` above (see the
 * module doc in coverage-prover.ts for why this is NOT folded into it).
 */
describe('coverage prover — effective-key (body proves it)', () => {
	it('group-by proves the composite key {x, y}', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0, 1])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('group-by does NOT prove a strict subset of the group key', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			// Two distinct groups can share x ⇒ {x} is not a key on the output.
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: false, reason: 'not-a-key' });
		} finally {
			await db.close();
		}
	});

	it('group-by proves a superset of the group key (superkey semantics)', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			// [0,1,2] is a superset of the real key {0,1} ⇒ still unique.
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0, 1, 2])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('nullable group key still proves it (strict-unique ⟹ NULL-permissive unique)', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null)',
		]);
		try {
			const root = bodyRoot(db, 'select x, count(*) from t group by x');
			expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('non-aggregating body: PK FD flows through projection', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer)',
		]);
		try {
			const root = bodyRoot(db, 'select id, x from t');
			expect(proveEffectiveKeyUnique(root, [0]), 'id is a key').to.deep.equal({ proved: true });
			expect(proveEffectiveKeyUnique(root, [1]), 'x alone is not a key').to.deep.equal({ proved: false, reason: 'not-a-key' });
		} finally {
			await db.close();
		}
	});

	it('out-of-frame: a key index beyond the output columns', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null)',
		]);
		try {
			const root = bodyRoot(db, 'select x, count(*) from t group by x');
			expect(proveEffectiveKeyUnique(root, [99])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		} finally {
			await db.close();
		}
	});
});

/**
 * Stub-based unit coverage for `proveEffectiveKeyUnique` — mirrors
 * test/optimizer/keysof-isunique.spec.ts: a lightweight `RelationType` +
 * `physical.fds` stub (no full plan tree) exercises the out-of-frame guard and
 * the delegation to `isUnique`.
 */
describe('coverage prover — effective-key (stub unit)', () => {
	function makeRoot(opts: {
		columnCount: number;
		isSet?: boolean;
		keys?: ColRef[][];
		fds?: FunctionalDependency[];
	}): RelationalPlanNode {
		const columns = Array.from({ length: opts.columnCount }, (_, i) => ({
			name: `c${i}`,
			type: { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true },
		}));
		const type: RelationType = {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: opts.isSet ?? false,
			columns,
			keys: opts.keys ?? [],
			rowConstraints: [],
		} as RelationType;
		const physical = { fds: opts.fds } as PhysicalProperties;
		// Only getType()/physical are touched by proveEffectiveKeyUnique → isUnique.
		return { getType: () => type, physical } as unknown as RelationalPlanNode;
	}

	it('out-of-frame guard fires for indices below 0 or ≥ columnCount', () => {
		const root = makeRoot({ columnCount: 2, fds: [{ determinants: [0], dependents: [1] }] });
		expect(proveEffectiveKeyUnique(root, [2])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		expect(proveEffectiveKeyUnique(root, [-1])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		// A mix where one index is out of frame still reports out-of-frame.
		expect(proveEffectiveKeyUnique(root, [0, 5])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
	});

	it('delegates to isUnique: FD-derived key proves, non-key does not', () => {
		const root = makeRoot({ columnCount: 2, fds: [{ determinants: [0], dependents: [1] }] });
		expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: true });
		expect(proveEffectiveKeyUnique(root, [1])).to.deep.equal({ proved: false, reason: 'not-a-key' });
	});

	it('empty key columns: proved only when the relation is ≤1 row', () => {
		// ∅ → all_cols ⇒ the empty key holds ⇒ [] is unique.
		const oneRow = makeRoot({ columnCount: 2, fds: [{ determinants: [], dependents: [0, 1] }] });
		expect(proveEffectiveKeyUnique(oneRow, [])).to.deep.equal({ proved: true });
		// A bag with no ≤1-row guarantee: [] is not a key.
		const bag = makeRoot({ columnCount: 2 });
		expect(proveEffectiveKeyUnique(bag, [])).to.deep.equal({ proved: false, reason: 'not-a-key' });
	});
});
