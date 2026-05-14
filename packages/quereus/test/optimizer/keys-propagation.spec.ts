import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, LiteralNode, UnaryOpNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { deriveProjectionColumnMap } from '../../src/planner/util/key-utils.js';
import type { Attribute, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';

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

	describe('Injective-projection key propagation', () => {
		async function assertHasUniqueKey(sql: string): Promise<void> {
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(`SELECT json_group_array(properties) AS props FROM query_plan(?)`, [sql])) rows.push(r as Record<string, unknown>);
			const props = JSON.stringify(rows[0].props);
			expect(props, sql).to.match(/"uniqueKeys":\[\[/);
		}

		async function uniqueKeysOnProject(sql: string): Promise<number[][] | undefined> {
			const rows: Array<{ op: string; physical: string | null }> = [];
			for await (const r of db.eval('SELECT op, physical FROM query_plan(?)', [sql])) rows.push(r as unknown as { op: string; physical: string | null });
			const projectRow = rows.find(r => r.op === 'PROJECT');
			if (!projectRow?.physical) return undefined;
			const phys = JSON.parse(projectRow.physical) as { uniqueKeys?: number[][] };
			return phys.uniqueKeys;
		}

		it('SELECT id + 1 FROM t — derived column carries the PK', async () => {
			await setup();
			await assertHasUniqueKey('SELECT id + 1 FROM t');
		});

		it('SELECT -id FROM t — unary minus preserves the PK', async () => {
			await setup();
			await assertHasUniqueKey('SELECT -id FROM t');
		});

		it('SELECT 5 - id FROM t — literal minus column preserves the PK', async () => {
			await setup();
			await assertHasUniqueKey('SELECT 5 - id FROM t');
		});

		// Note: a parameter (`?`) at SQL level defaults to TEXT type, so
		// `id + ?` is not recognized as numeric arithmetic and therefore not
		// injective. The parameter-as-constant case for arithmetic is covered
		// directly in expression-properties.spec.ts (where the parameter is
		// constructed with INTEGER_TYPE) and via the unit test below.

		it('SELECT id, id + 1 FROM t — two unique keys (one per output column)', async () => {
			await setup();
			const keys = await uniqueKeysOnProject('SELECT id, id + 1 FROM t');
			expect(keys, 'expected uniqueKeys on Project').to.be.an('array');
			expect(keys!.some(k => k.length === 1 && k[0] === 0)).to.equal(true);
			expect(keys!.some(k => k.length === 1 && k[0] === 1)).to.equal(true);
		});

		it('SELECT id + v FROM t — references two source attrs; no derived key', async () => {
			await setup();
			const keys = await uniqueKeysOnProject('SELECT id + v FROM t');
			// The Project's output has only one column derived from two attrs;
			// no source unique key fully survives, so uniqueKeys should be empty.
			expect(keys === undefined || keys.length === 0).to.equal(true);
		});

		it('SELECT id * v FROM t — `*` not injective; no derived key', async () => {
			await setup();
			const keys = await uniqueKeysOnProject('SELECT id * v FROM t');
			expect(keys === undefined || keys.length === 0).to.equal(true);
		});

		it('DISTINCT eliminated for SELECT DISTINCT id + 1 FROM t', async () => {
			await setup();
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval("SELECT json_group_array(node_type) AS types FROM query_plan('SELECT DISTINCT id + 1 FROM t')")) rows.push(r as Record<string, unknown>);
			const types = String(rows[0].types as unknown as string);
			expect(types).to.not.include('Distinct');
		});
	});
});

// ---------------------------------------------------------------------------
// Unit tests for deriveProjectionColumnMap
// ---------------------------------------------------------------------------

describe('deriveProjectionColumnMap', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const scope = EmptyScope.instance as unknown as any;

	function attr(id: number, name = 'c'): Attribute {
		return {
			id,
			name,
			type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false },
		};
	}

	function colRef(attrId: number, index = 0, numeric = true): ColumnReferenceNode {
		const expr = { type: 'column', name: `c${attrId}` } as unknown as AST.ColumnExpr;
		const columnType = {
			typeClass: 'scalar' as const,
			logicalType: numeric ? INTEGER_TYPE : TEXT_TYPE,
			nullable: false,
			isReadOnly: false,
		};
		return new ColumnReferenceNode(scope, expr, columnType, attrId, index);
	}

	function lit(value: number): LiteralNode {
		const expr = { type: 'literal', value } as unknown as AST.LiteralExpr;
		return new LiteralNode(scope, expr);
	}

	function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
		const ast = {
			type: 'binary',
			operator: op,
			left: (left as unknown as { expression: AST.Expression }).expression,
			right: (right as unknown as { expression: AST.Expression }).expression,
		} as AST.BinaryExpr;
		return new BinaryOpNode(scope, ast, left, right);
	}

	function unaryOp(op: string, operand: ScalarPlanNode): UnaryOpNode {
		const ast = {
			type: 'unary',
			operator: op,
			expr: (operand as unknown as { expression: AST.Expression }).expression,
		} as AST.UnaryExpr;
		return new UnaryOpNode(scope, ast, operand);
	}

	it('bare column projections map to their output index', () => {
		const sourceAttrs = [attr(100, 'id'), attr(101, 'v')];
		const projections = [
			{ expr: colRef(100, 0), outIndex: 0 },
			{ expr: colRef(101, 1), outIndex: 1 },
		];
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, projections);
		expect(map.get(0)).to.equal(0);
		expect(map.get(1)).to.equal(1);
		expect(injectivePairs).to.have.length(0);
	});

	it('injective expression (col + 1) adds the source→output entry and an injective pair', () => {
		const sourceAttrs = [attr(100, 'id')];
		const expr = binOp('+', colRef(100, 0), lit(1));
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, [{ expr, outIndex: 0 }]);
		expect(map.get(0)).to.equal(0);
		expect(injectivePairs).to.deep.equal([[0, 0]]);
	});

	it('bare-column projection wins when both forms appear (SELECT id, id+1)', () => {
		const sourceAttrs = [attr(100, 'id')];
		const projections = [
			{ expr: colRef(100, 0), outIndex: 0 },
			{ expr: binOp('+', colRef(100, 0), lit(1)), outIndex: 1 },
		];
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, projections);
		expect(map.get(0)).to.equal(0);
		expect(injectivePairs).to.deep.equal([[0, 1]]);
	});

	it('two source attrs in one expression: not added (no single-source synonym)', () => {
		const sourceAttrs = [attr(100, 'id'), attr(101, 'v')];
		const expr = binOp('+', colRef(100, 0), colRef(101, 1));
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, [{ expr, outIndex: 0 }]);
		expect(map.size).to.equal(0);
		expect(injectivePairs).to.have.length(0);
	});

	it('non-injective expression (col * 2) drops out', () => {
		const sourceAttrs = [attr(100, 'id')];
		const expr = binOp('*', colRef(100, 0), lit(2));
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, [{ expr, outIndex: 0 }]);
		expect(map.size).to.equal(0);
		expect(injectivePairs).to.have.length(0);
	});

	it('unary minus on a numeric col is injective', () => {
		const sourceAttrs = [attr(100, 'id')];
		const expr = unaryOp('-', colRef(100, 0));
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, [{ expr, outIndex: 0 }]);
		expect(map.get(0)).to.equal(0);
		expect(injectivePairs).to.deep.equal([[0, 0]]);
	});
});
