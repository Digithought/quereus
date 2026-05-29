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
import type { MaterializedViewSchema } from '../src/schema/view.js';
import { parseSelect } from '../src/parser/index.js';
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

/**
 * Runs the prover against a body that is *planned but not materialized*. Needed
 * for RIGHT JOIN, which plans correctly but is not executable yet (so it cannot
 * back a real MV — `collectBodyRows` throws "RIGHT JOIN is not supported yet").
 * `proveCoverage` reads only `mv.selectAst`, so a stub carrying the parsed body
 * suffices to exercise the prover's `'right'`-join branch end to end.
 */
function proveUnmaterialized(
	db: Database,
	bodySql: string,
	tableName: string,
	ucIndex = 0,
): CoverageResult {
	const table = db.schemaManager.getTable('main', tableName)!;
	const uc = table.uniqueConstraints![ucIndex];
	const mvStub = { selectAst: parseSelect(bodySql) } as unknown as MaterializedViewSchema;
	return proveCoverage(bodyRoot(db, bodySql), mvStub, uc, table);
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

/**
 * Multi-source (join) bodies — the prover admits a join body as covering a
 * single-table UNIQUE constraint when `T` provably contributes exactly one MV
 * row per governed `T` row (no row loss + no fan-out). See the coverage-prover
 * module doc § "The 1:1 join decomposition".
 *
 * NOTE on join survival: none of these DDLs declare a foreign key, so
 * `rule-join-elimination` (which needs FK→PK alignment) never fires and the join
 * survives to the optimized plan — exercising the new multi-source walk rather
 * than collapsing to the v1 single-source path.
 */
describe('coverage prover — multi-source (join) bodies', () => {
	// orders(unique(customer_id, sku)) left-joined to a unique lookup key: 1:1.
	const ORDERS_CUSTOMERS = [
		'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
		'create table customers (id integer primary key, name text)',
	];

	it('positive: LEFT join to a unique lookup key (T on the preserving left side) covers', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			expect((await prove(db, 'ix', body, 'orders')).covers, 'left-join to unique lookup is 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('positive: RIGHT join with the lookup on the left (T on the preserving right side) covers', async () => {
		// RIGHT JOIN is not executable yet, so the MV cannot be materialized; prove
		// against the planned body directly (the prover's `'right'`-join branch).
		const body = 'select o.customer_id, o.sku, o.id from customers c right join orders o on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb(ORDERS_CUSTOMERS);
		try {
			expect(proveUnmaterialized(db, body, 'orders').covers, 'symmetric right-join case').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative fanout: LEFT join on a NON-unique lookup key multiplies T rows', async () => {
		// tags.val is not unique (PK is on a different column) ⇒ one orders row can
		// match many tags rows ⇒ the join fans out.
		const body = 'select o.customer_id, o.sku, o.id from orders o left join tags t on o.customer_id = t.val order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
			'create table tags (id integer primary key, val integer not null, label text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a fanning lookup join must not cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('fanout');
		} finally {
			await db.close();
		}
	});

	it('negative shape: the same body as an INNER join loses unmatched T rows', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o inner join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'inner join cannot prove no-row-loss').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: T on the dropping side of an outer join', async () => {
		// customers LEFT JOIN orders preserves customers; orders rows with no
		// matching customer are dropped ⇒ row loss for orders.
		const body = 'select o.customer_id, o.sku, o.id from customers c left join orders o on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'T on the non-preserving side cannot cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: self-join of T to T is ambiguous', async () => {
		const body = 'select o1.customer_id, o1.sku, o1.id from orders o1 join orders o2 on o1.id = o2.id order by o1.customer_id, o1.sku';
		const db = await freshDb([
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'self-join puts T on both sides ⇒ ambiguous').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative: WHERE referencing a lookup column cannot sneak through', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id where c.name is not null order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a non-T filter must not be accepted').to.be.false;
			// Either the optimizer null-rejected the LEFT join into an INNER join
			// (rejected by the structural side/type gate ⇒ 'shape') or it survived as
			// a LEFT join and the AST WHERE (on a non-T column) failed predicate
			// alignment ⇒ 'predicate-entailment'. Both are sound rejections.
			if (!result.covers) expect(['shape', 'predicate-entailment']).to.include(result.reason);
		} finally {
			await db.close();
		}
	});

	it('eager link: a covering join MV stamps covers + coveringStructureName', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS, `create materialized view ix as ${body}`]);
		try {
			const uc = db.schemaManager.getTable('main', 'orders')!.uniqueConstraints![0];
			expect(uc.coveringStructureName, 'forward pointer set to the join MV').to.equal('ix');
			const mv = db.schemaManager.getMaterializedView('main', 'ix')!;
			expect(mv.covers).to.deep.include({ schemaName: 'main', tableName: 'orders' });
		} finally {
			await db.close();
		}
	});

	it('eager link: a fanning join MV stamps nothing', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join tags t on o.customer_id = t.val order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
			'create table tags (id integer primary key, val integer not null, label text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect(db.schemaManager.getTable('main', 'orders')!.uniqueConstraints![0].coveringStructureName).to.be.undefined;
			expect(db.schemaManager.getMaterializedView('main', 'ix')!.covers).to.be.undefined;
		} finally {
			await db.close();
		}
	});

	// --- Nested joins: the topmost-join capture + per-join structural gate +
	//     composed join-frame FDs must hold for a chain of joins, not just one. ---

	it('positive: nested LEFT joins, both 1:1, cover', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id left join addresses a on o.id = a.id order by o.customer_id, o.sku';
		const db = await freshDb([
			...ORDERS_CUSTOMERS,
			'create table addresses (id integer primary key, city text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect((await prove(db, 'ix', body, 'orders')).covers, 'a 1:1 chain of LEFT joins is still 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative fanout: nested LEFT joins where the OUTER join fans out (deeper-than-top fan-out is caught at the join frame)', async () => {
		// orders LJ customers is 1:1, but the outer LJ tags (tags.val non-unique)
		// fans out. The fan-out gate checks isUnique(orders.pk) at the *topmost*
		// join frame, whose FDs do not let orders.pk reach the tags columns ⇒ fanout.
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id left join tags t on o.customer_id = t.val order by o.customer_id, o.sku';
		const db = await freshDb([
			...ORDERS_CUSTOMERS,
			'create table tags (id integer primary key, val integer not null, label text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a fan-out below the top join must still be caught').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('fanout');
		} finally {
			await db.close();
		}
	});

	it('positive: a composite-PK table maps every PK attribute into the join frame', async () => {
		// line_items has a 2-column PK (oid, lineno); the covered UC is (oid, sku).
		// The fan-out gate must map BOTH pk attributes into the join frame for the
		// isUnique check, not just the first. The lookup is on region_id (a non-UC,
		// non-PK column) to a unique key, with no lookup-side name colliding with a
		// UC column — so the name-collision guard does not (correctly) intervene.
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join regions r on l.region_id = r.rid order by l.oid, l.sku';
		const db = await freshDb([
			'create table line_items (oid integer not null, lineno integer not null, sku text not null, region_id integer not null, primary key (oid, lineno), unique (oid, sku))',
			'create table regions (rid integer primary key, rname text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			expect((await prove(db, 'ix', body, 'line_items')).covers, 'composite-PK 1:1 lookup join covers').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative shape: a join on a UC column whose lookup side reuses that column name is rejected (name-collision guard)', async () => {
		// products.sku collides with the UC column `sku`; bare-name resolution in
		// the ORDER BY / WHERE checks could mis-resolve it, so the guard rejects.
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join products p on l.sku = p.sku order by l.oid, l.sku';
		const db = await freshDb([
			'create table line_items (oid integer not null, lineno integer not null, sku text not null, primary key (oid, lineno), unique (oid, sku))',
			'create table products (sku text primary key, name text)',
			`create materialized view ix as ${body}`,
		]);
		try {
			const result = await prove(db, 'ix', body, 'line_items');
			expect(result.covers, 'a lookup column reusing a UC column name must be rejected').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
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
