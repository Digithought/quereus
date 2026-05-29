import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * The bag-body contract: a v1 materialized view must be a *set*. A
 * duplicate-producing body fails with a purpose-built diagnostic that names the
 * MV and explains the contract — NOT the raw `UNIQUE constraint failed:
 * sqlite_mv_<name> PK` that leaks the hidden backing table.
 *
 * The sqllogic harness (`51-materialized-views.sqllogic` §9) covers the positive
 * "must be a set" substring and the create/refresh behavior; it cannot express
 * the *negative* assertion below, so this focused spec locks the user-facing
 * wording in.
 */
describe('Materialized view bag-body diagnostic', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	it('names the MV and the set contract, not the backing table', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);

		const err = await captureError('create materialized view mv_status as select status from orders;');

		// Purpose-built, user-facing wording…
		expect(err.message).to.contain('must be a set');
		expect(err.message).to.contain("mv_status");
		// …and it never leaks the hidden backing-table implementation detail.
		expect(err.message).to.not.contain('sqlite_mv_');
		expect(err.message).to.not.contain('PK.');
	});

	it('rolls the backing table back so the MV name stays free after a failed create', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);
		await captureError('create materialized view mv_status as select status from orders;');

		// A de-duplicated body over the same source must succeed — proving the
		// failed create did not half-register the name or leave a backing table.
		await db.exec('create materialized view mv_status as select distinct status from orders;');
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval('select * from mv_status order by status')) {
			rows.push(row);
		}
		expect(rows).to.deep.equal([{ status: 'open' }, { status: 'shipped' }]);
	});
});
