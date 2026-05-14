import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { createTableValuedFunction } from '../../src/func/registration.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';
import type { Row, SqlValue } from '../../src/common/types.js';

interface PlanRow {
	id: number;
	parent_id: number | null;
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

interface MonotonicOnEntry {
	attrId: number;
	strict: boolean;
	direction: 'asc' | 'desc';
}

interface PhysicalProps {
	uniqueKeys?: number[][];
	fds?: { determinants: number[]; dependents: number[] }[];
	ordering?: { column: number; desc: boolean }[];
	estimatedRows?: number;
	monotonicOn?: MonotonicOnEntry[];
}

async function planRows(db: Database, sql: string, params?: SqlValue[]): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	const args: SqlValue[] = [sql, ...(params ?? [])];
	const planSql = params && params.length > 0
		? 'SELECT id, parent_id, node_type, op, detail, properties, physical FROM query_plan(?)'
		: 'SELECT id, parent_id, node_type, op, detail, properties, physical FROM query_plan(?)';
	// query_plan only takes the SQL — parameters are not passed through to the inner plan,
	// so use a single ? in the *inner* SQL and inspect that plan instead.
	for await (const r of db.eval(planSql, [args[0]])) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function physicalOf(rows: readonly PlanRow[], pred: (r: PlanRow) => boolean): PhysicalProps | undefined {
	const row = rows.find(pred);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

function propertiesOf(rows: readonly PlanRow[], pred: (r: PlanRow) => boolean): Record<string, unknown> | undefined {
	const row = rows.find(pred);
	if (!row || !row.properties) return undefined;
	return JSON.parse(row.properties) as Record<string, unknown>;
}

describe('TVF physical property advertisements', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});
	afterEach(async () => {
		await db.close();
	});

	describe('generate_series', () => {
		it('with literal bounds, the call folds to a TableLiteral preserving advertised est_rows', async () => {
			// The optimizer folds a fully-constant generate_series into a TableLiteral.
			// est_rows on the folded node should still reflect the advertised 100 rows.
			const rows = await planRows(db, 'SELECT * FROM generate_series(1, 100)');
			const tl = rows.find((r) => r.op === 'TABLELITERAL');
			expect(tl, 'folded TableLiteral present').to.not.equal(undefined);
			expect(propertiesOf(rows, (r) => r.op === 'TABLELITERAL')!.numRows).to.equal(100);
		});

		it('with a parameter bound, the TableFunctionCall stays in the plan and advertises uniqueKeys/ordering/monotonicOn', async () => {
			const rows = await planRows(db, 'SELECT * FROM generate_series(1, ?)');
			const tfc = physicalOf(rows, (r) => r.op === 'TABLEFUNCTIONCALL');
			expect(tfc, 'TableFunctionCall present').to.not.equal(undefined);
			expect(tfc!.uniqueKeys).to.deep.equal([[0]]);
			expect(tfc!.ordering).to.deep.equal([{ column: 0, desc: false }]);
			expect(tfc!.monotonicOn).to.be.an('array').with.lengthOf(1);
			expect(tfc!.monotonicOn![0].direction).to.equal('asc');
			expect(tfc!.monotonicOn![0].strict).to.equal(true);
			// estimatedRows is intentionally not advertised when an operand is a parameter.
			expect(tfc!.estimatedRows).to.equal(undefined);
		});

		// TODO: ORDER BY on a TVF advertising matching monotonicOn does not yet
		// trigger Sort elimination — no general-purpose rule covers this case
		// today (rule-monotonic-limit-pushdown requires LIMIT + ordinalSeek;
		// rule-grow-retrieve targets RetrieveNode only). The advertisement is
		// present in physical properties, so a future rule can read it off.
		it('annotates the TableFunctionCall with monotonicOn even when Sort remains above', async () => {
			const rows = await planRows(db, 'SELECT * FROM generate_series(1, ?) ORDER BY value');
			const tfc = physicalOf(rows, (r) => r.op === 'TABLEFUNCTIONCALL');
			expect(tfc, 'TableFunctionCall present').to.not.equal(undefined);
			expect(tfc!.monotonicOn).to.be.an('array').with.lengthOf(1);
		});
	});

	describe('json_each / json_tree', () => {
		it("DISTINCT id from json_each(?) does not produce a Distinct node", async () => {
			const rows = await planRows(db, 'SELECT DISTINCT id FROM json_each(?)');
			const distinct = rows.find((r) => r.op === 'DISTINCT');
			expect(distinct, 'DISTINCT should be elidable when source is set on key').to.equal(undefined);
		});

		it('json_tree(?) advertises uniqueKeys on id (column 4)', async () => {
			const rows = await planRows(db, 'SELECT * FROM json_tree(?)');
			const tfc = physicalOf(rows, (r) => r.op === 'TABLEFUNCTIONCALL');
			expect(tfc, 'TableFunctionCall present').to.not.equal(undefined);
			expect(tfc!.uniqueKeys).to.deep.equal([[4]]);
		});
	});

	describe('FD-from-injective-projections flows through TVF outputs', () => {
		it('SELECT value + 1 AS v FROM generate_series(1, ?) projects key onto v', async () => {
			const rows = await planRows(db, 'SELECT value + 1 AS v FROM generate_series(1, ?)');
			const project = physicalOf(rows, (r) => r.op === 'PROJECT');
			expect(project, 'Project node present').to.not.equal(undefined);
			// `+ 1` is injective in `value`, so the projected `v` is also a key.
			expect(project!.uniqueKeys, 'projected uniqueKeys').to.not.equal(undefined);
			expect(project!.uniqueKeys!.some((k) => k.length === 1 && k[0] === 0)).to.equal(true);
		});
	});

	describe('Validation drops bad advertisements safely', () => {
		it('TVF with out-of-range key advertisement runs but does not expose uniqueKeys', async () => {
			const badTvf = createTableValuedFunction(
				{
					name: 'bad_keys_tvf',
					numArgs: 1,
					deterministic: true,
					returnType: {
						typeClass: 'relation',
						isReadOnly: true,
						isSet: false,
						columns: [
							{
								name: 'a',
								type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
								generated: true,
							},
						],
						keys: [],
						rowConstraints: [],
					},
					relationalAdvertisement: {
						keys: [[{ index: 99 }]], // Out of range
					},
				},
				async function* (_arg: SqlValue): AsyncIterable<Row> {
					yield [1];
					yield [2];
				},
			);
			db.registerFunction(badTvf);

			// Use a parameter to keep the TableFunctionCall in the optimized plan.
			const rows = await planRows(db, 'SELECT * FROM bad_keys_tvf(?)');
			const tfc = physicalOf(rows, (r) => r.op === 'TABLEFUNCTIONCALL');
			expect(tfc, 'TableFunctionCall present').to.not.equal(undefined);
			expect(tfc!.uniqueKeys ?? []).to.deep.equal([]);

			// Query still executes correctly.
			const results: number[] = [];
			for await (const r of db.eval('SELECT a FROM bad_keys_tvf(?)', [0])) {
				results.push((r as { a: number }).a);
			}
			expect(results).to.deep.equal([1, 2]);
		});
	});

	describe('properties JSON exposes TVF column list', () => {
		it('parameter-bound generate_series exposes its column list in properties', async () => {
			const rows = await planRows(db, 'SELECT * FROM generate_series(1, ?)');
			const props = propertiesOf(rows, (r) => r.op === 'TABLEFUNCTIONCALL');
			expect(props, 'properties present').to.not.equal(undefined);
			expect(props!.columns).to.deep.equal(['value']);
		});
	});
});
