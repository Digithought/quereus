import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	extractCheckConstraints,
} from '../../src/planner/analysis/check-extraction.js';
import { extractPartialUniqueGuardedFds } from '../../src/planner/analysis/partial-unique-extraction.js';
import {
	predicateImpliesGuard,
	projectFds,
	shiftFds,
	addFd,
	stripGuard,
} from '../../src/planner/util/fd-utils.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, LiteralNode, UnaryOpNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import type {
	ConstantBinding,
	FunctionalDependency,
	GuardPredicate,
	ScalarPlanNode,
} from '../../src/planner/nodes/plan-node.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { RowConstraintSchema, TableSchema, UniqueConstraintSchema } from '../../src/schema/table.js';
import { DEFAULT_ROWOP_MASK, buildColumnIndexMap } from '../../src/schema/table.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';

// ---------------------------------------------------------------------------
// AST + scalar-node builders shared by unit tests
// ---------------------------------------------------------------------------

const scope = EmptyScope.instance as unknown as never;
const intType = { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false };
const intTypeNullable = { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: true, isReadOnly: false };
const textType = { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false, isReadOnly: false };

function lit(value: AST.LiteralExpr['value']): AST.LiteralExpr {
	return { type: 'literal', value };
}

function colExpr(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

function bin(operator: string, left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return { type: 'binary', operator, left, right };
}

function or(left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return bin('OR', left, right);
}

function un(operator: string, expr: AST.Expression): AST.UnaryExpr {
	return { type: 'unary', operator, expr };
}

function check(expr: AST.Expression): RowConstraintSchema {
	return { expr, operations: DEFAULT_ROWOP_MASK };
}

function colNode(attrId: number, index: number, nullable = false): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` };
	return new ColumnReferenceNode(scope, expr, nullable ? intTypeNullable : intType, attrId, index);
}

function textColNode(attrId: number, index: number): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` };
	return new ColumnReferenceNode(scope, expr, textType, attrId, index);
}

function litNode(value: AST.LiteralExpr['value']): LiteralNode {
	const expr: AST.LiteralExpr = { type: 'literal', value };
	return new LiteralNode(scope, expr);
}

function eqNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: '=',
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function gtNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: '>',
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function andNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: 'AND',
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function isNullUnary(operand: ScalarPlanNode, negated: boolean): UnaryOpNode {
	const ast: AST.UnaryExpr = {
		type: 'unary',
		operator: negated ? 'IS NOT NULL' : 'IS NULL',
		expr: (operand as unknown as { expression: AST.Expression }).expression,
	};
	return new UnaryOpNode(scope, ast, operand);
}

// ---------------------------------------------------------------------------
// predicateImpliesGuard — unit tests
// ---------------------------------------------------------------------------

describe('predicateImpliesGuard', () => {
	const attrMap = new Map<number, number>([[100, 0], [101, 1], [102, 2]]);
	const noBindings: ConstantBinding[] = [];
	const noEcs: ReadonlyArray<ReadonlyArray<number>> = [];
	const allNullable = () => false;

	it('eq-literal direct match: predicate c = "x" entails guard {c="x"}', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
		const pred = eqNode(textColNode(100, 0), litNode('x'));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable)).to.equal(true);
	});

	it('eq-literal via EC: predicate c1="x" and c1=c2 entails guard {c2="x"}', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 1, value: 'x' }] };
		const pred = andNode(
			eqNode(textColNode(100, 0), litNode('x')),
			eqNode(colNode(100, 0), colNode(101, 1)),
		);
		const ecs: ReadonlyArray<ReadonlyArray<number>> = [[0, 1]];
		expect(predicateImpliesGuard(pred, guard, ecs, noBindings, attrMap, allNullable)).to.equal(true);
	});

	it('eq-literal via existing binding', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 5 }] };
		// Trivial predicate; binding carries the fact.
		const pred = eqNode(litNode(1), litNode(1));
		const bindings: ConstantBinding[] = [
			{ attrs: [0], value: { kind: 'literal', value: 5 } },
		];
		expect(predicateImpliesGuard(pred, guard, noEcs, bindings, attrMap, allNullable)).to.equal(true);
	});

	it('eq-column via existing EC', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-column', left: 0, right: 1 }] };
		const pred = eqNode(litNode(1), litNode(1));
		const ecs: ReadonlyArray<ReadonlyArray<number>> = [[0, 1]];
		expect(predicateImpliesGuard(pred, guard, ecs, noBindings, attrMap, allNullable)).to.equal(true);
	});

	it('eq-column via predicate conjunct', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-column', left: 0, right: 1 }] };
		const pred = eqNode(colNode(100, 0), colNode(101, 1));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable)).to.equal(true);
	});

	it('is-null direct: predicate c is null matches guard {c is null}', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'is-null', column: 0, negated: false }] };
		const pred = isNullUnary(colNode(100, 0, true), false);
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable)).to.equal(true);
	});

	it('is-null negated via non-nullable column metadata', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'is-null', column: 0, negated: true }] };
		const pred = eqNode(litNode(1), litNode(1));
		const nonNullable = (col: number) => col === 0;
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, nonNullable)).to.equal(true);
	});

	it('is-null negated via "is not null" predicate conjunct', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'is-null', column: 0, negated: true }] };
		const pred = isNullUnary(colNode(100, 0, true), true);
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable)).to.equal(true);
	});

	it('conservative false: predicate c > 5 does not entail guard {c = "x"}', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
		const pred = gtNode(colNode(100, 0), litNode(5));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable)).to.equal(false);
	});

	it('conservative false: top-level OR with no AND-conjunct match', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
		const orAst: AST.BinaryExpr = {
			type: 'binary',
			operator: 'OR',
			left: eqNode(textColNode(100, 0), litNode('x')).expression,
			right: eqNode(textColNode(100, 0), litNode('y')).expression,
		};
		const pred = new BinaryOpNode(
			scope,
			orAst,
			eqNode(textColNode(100, 0), litNode('x')),
			eqNode(textColNode(100, 0), litNode('y')),
		);
		// Our extractor only walks AND-conjunctions; a top-level OR yields no facts.
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable)).to.equal(false);
	});

	it('conjunctive guard requires all clauses to match', () => {
		const guard: GuardPredicate = {
			clauses: [
				{ kind: 'eq-literal', column: 0, value: 'x' },
				{ kind: 'is-null', column: 1, negated: true },
			],
		};
		// Only the literal half holds.
		const pred = eqNode(textColNode(100, 0), litNode('x'));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable)).to.equal(false);
		// Both halves hold.
		const pred2 = andNode(
			eqNode(textColNode(100, 0), litNode('x')),
			isNullUnary(colNode(101, 1, true), true),
		);
		expect(predicateImpliesGuard(pred2, guard, noEcs, noBindings, attrMap, allNullable)).to.equal(true);
	});
});

// ---------------------------------------------------------------------------
// CHECK extraction — unit tests for implication-form recognition
// ---------------------------------------------------------------------------

const checkColMap = new Map<string, number>([
	['id', 0],
	['status', 1],
	['region', 2],
	['assigned', 3],
	['deleted_at', 4],
	['x', 5],
	['y', 6],
	['a', 7],
	['b', 8],
]);
const allDeterministic = () => true;

describe('extractCheckConstraints (implication form)', () => {
	it("check (status <> 'active' or assigned = region) emits two guarded FDs", () => {
		const expr = or(
			bin('!=', colExpr('status'), lit('active')),
			bin('=', colExpr('assigned'), colExpr('region')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
		expect(result.fds).to.have.length(2);
		for (const fd of result.fds) {
			expect(fd.guard, 'expected guard on body FD').to.not.equal(undefined);
			expect(fd.guard!.clauses).to.have.length(1);
			const c = fd.guard!.clauses[0];
			expect(c.kind).to.equal('eq-literal');
			if (c.kind !== 'eq-literal') return;
			expect(c.column).to.equal(1);
			expect(c.value).to.equal('active');
		}
		const detSets = result.fds.map(fd => fd.determinants[0]).sort();
		expect(detSets).to.deep.equal([2, 3]);
	});

	it('check (deleted_at is not null or x = y) emits guarded FDs with is-null guard', () => {
		const expr = or(
			un('IS NOT NULL', colExpr('deleted_at')),
			bin('=', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic);
		expect(result.fds).to.have.length(2);
		for (const fd of result.fds) {
			expect(fd.guard!.clauses).to.have.length(1);
			const c = fd.guard!.clauses[0];
			expect(c.kind).to.equal('is-null');
			if (c.kind !== 'is-null') return;
			expect(c.column).to.equal(4);
			expect(c.negated).to.equal(false);
		}
	});

	it('check (a <> 1 or b <> 2 or x = y) — two-clause guard, both must hold', () => {
		const expr = or(
			or(bin('!=', colExpr('a'), lit(1)), bin('!=', colExpr('b'), lit(2))),
			bin('=', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic);
		expect(result.fds).to.have.length(2);
		const guard = result.fds[0].guard!;
		expect(guard.clauses).to.have.length(2);
		const cols = guard.clauses
			.filter(c => c.kind === 'eq-literal')
			.map(c => (c as { kind: 'eq-literal'; column: number; value: AST.LiteralExpr['value'] }).column)
			.sort();
		expect(cols).to.deep.equal([7, 8]);
	});

	it("check (status = 'active') falls through to unguarded equality recognition", () => {
		const expr = bin('=', colExpr('status'), lit('active'));
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].guard).to.equal(undefined);
		expect(result.constantBindings).to.have.length(1);
	});

	it("check (status <> 'active' or x > y) — non-equality body produces nothing", () => {
		const expr = or(
			bin('!=', colExpr('status'), lit('active')),
			bin('>', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic);
		expect(result.fds).to.have.length(0);
	});
});

// ---------------------------------------------------------------------------
// fd-utils — guard projection / shifting / equality
// ---------------------------------------------------------------------------

describe('fd-utils: guarded FD helpers', () => {
	const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
	const fd: FunctionalDependency = { determinants: [1], dependents: [2], guard };

	it('shiftFds shifts guard columns alongside determinants/dependents', () => {
		const shifted = shiftFds([fd], 10);
		expect(shifted[0].determinants).to.deep.equal([11]);
		expect(shifted[0].dependents).to.deep.equal([12]);
		expect(shifted[0].guard).to.not.equal(undefined);
		const c = shifted[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(10);
	});

	it('projectFds drops a guarded FD when a guard column is missing from the mapping', () => {
		const mapping = new Map<number, number>([[1, 100], [2, 200]]); // guard col 0 missing
		const out = projectFds([fd], mapping);
		expect(out).to.have.length(0);
	});

	it('projectFds remaps a guarded FD when every column survives', () => {
		const mapping = new Map<number, number>([[0, 50], [1, 100], [2, 200]]);
		const out = projectFds([fd], mapping);
		expect(out).to.have.length(1);
		expect(out[0].guard).to.not.equal(undefined);
		const c = out[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(50);
	});

	it('stripGuard removes the guard while preserving det/dep', () => {
		const stripped = stripGuard(fd);
		expect(stripped.guard).to.equal(undefined);
		expect(stripped.determinants).to.deep.equal(fd.determinants);
		expect(stripped.dependents).to.deep.equal(fd.dependents);
	});

	it('addFd keeps two same-det FDs side-by-side when only one is guarded', () => {
		const unguarded: FunctionalDependency = { determinants: [1], dependents: [2] };
		const after = addFd([unguarded], fd);
		expect(after).to.have.length(2);
	});

	it('addFd dedupes structurally equal guarded FDs', () => {
		const after = addFd([fd], { ...fd });
		expect(after).to.have.length(1);
	});
});

// ---------------------------------------------------------------------------
// Partial UNIQUE extraction — unit tests
// ---------------------------------------------------------------------------

function makeColumn(name: string, notNull: boolean, type = INTEGER_TYPE): ColumnSchema {
	return {
		name,
		logicalType: type,
		notNull,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY',
		generated: false,
	};
}

function makeSchema(columns: ColumnSchema[], uniqueConstraints: UniqueConstraintSchema[]): TableSchema {
	return {
		name: 't',
		schemaName: 'main',
		columns,
		columnIndexMap: buildColumnIndexMap(columns),
		primaryKeyDefinition: [],
		checkConstraints: [],
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vtabModule: undefined as any,
		vtabModuleName: 'memory',
		isView: false,
		uniqueConstraints,
	};
}

describe('extractPartialUniqueGuardedFds', () => {
	it('recognizes col = literal as a single eq-literal guard clause', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [1], predicate: bin('=', colExpr('status'), lit('active')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		expect(fds[0].determinants).to.deep.equal([1]);
		expect(fds[0].dependents).to.deep.equal([0, 2]);
		expect(fds[0].guard!.clauses).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(2);
		expect(c.value).to.equal('active');
	});

	it("recognizes literal = col (operand-flipped) as eq-literal", () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: bin('=', lit('active'), colExpr('status')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(1);
		expect(c.value).to.equal('active');
	});

	it('recognizes col1 = col2 as eq-column', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('a', true), makeColumn('b', true)],
			[{ columns: [0], predicate: bin('=', colExpr('a'), colExpr('b')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-column');
		if (c.kind !== 'eq-column') return;
		expect([c.left, c.right].sort()).to.deep.equal([1, 2]);
	});

	it('recognizes col IS NULL as is-null negated:false', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('deleted_at', false, TEXT_TYPE)],
			[{ columns: [0], predicate: un('IS NULL', colExpr('deleted_at')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('is-null');
		if (c.kind !== 'is-null') return;
		expect(c.column).to.equal(1);
		expect(c.negated).to.equal(false);
	});

	it('recognizes col IS NOT NULL as is-null negated:true', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('archived', false, TEXT_TYPE)],
			[{ columns: [0], predicate: un('IS NOT NULL', colExpr('archived')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('is-null');
		if (c.kind !== 'is-null') return;
		expect(c.column).to.equal(1);
		expect(c.negated).to.equal(true);
	});

	it('recognizes multi-conjunct AND into a multi-clause guard', () => {
		const schema = makeSchema(
			[
				makeColumn('c', true),
				makeColumn('status', true, TEXT_TYPE),
				makeColumn('region', true, TEXT_TYPE),
			],
			[{
				columns: [0],
				predicate: bin('AND',
					bin('=', colExpr('status'), lit('active')),
					bin('=', colExpr('region'), lit('us'))),
			}],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const clauses = fds[0].guard!.clauses;
		expect(clauses).to.have.length(2);
		const cols = clauses
			.filter(c => c.kind === 'eq-literal')
			.map(c => (c as { kind: 'eq-literal'; column: number; value: AST.LiteralExpr['value'] }).column)
			.sort();
		expect(cols).to.deep.equal([1, 2]);
	});

	it('rejects col > literal (range)', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('age', true)],
			[{ columns: [0], predicate: bin('>', colExpr('age'), lit(18)) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it("rejects col != literal", () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: bin('!=', colExpr('status'), lit('x')) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects col IN (...)', () => {
		const inExpr: AST.InExpr = {
			type: 'in',
			expr: colExpr('status'),
			values: [lit('a'), lit('b')],
		};
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: inExpr }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects top-level OR', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE), makeColumn('region', true, TEXT_TYPE)],
			[{
				columns: [0],
				predicate: or(
					bin('=', colExpr('status'), lit('a')),
					bin('=', colExpr('region'), lit('b'))),
			}],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects nullable UC column (NOT-NULL gate)', () => {
		const schema = makeSchema(
			[makeColumn('c', false), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: bin('=', colExpr('status'), lit('active')) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects the whole predicate if one conjunct is unrecognized (soundness)', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE), makeColumn('age', true)],
			[{
				columns: [0],
				predicate: bin('AND',
					bin('=', colExpr('status'), lit('active')),
					bin('>', colExpr('age'), lit(18))),
			}],
		);
		// One conjunct recognized, one not — whole FD is dropped.
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('skips non-partial UCs', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0] }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('returns nothing when table has no uniqueConstraints', () => {
		const schema = makeSchema([makeColumn('c', true)], []);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});
});

// ---------------------------------------------------------------------------
// End-to-end via query_plan(...)
// ---------------------------------------------------------------------------

interface PhysicalProps {
	fds?: { determinants: number[]; dependents: number[]; guard?: GuardPredicate }[];
	equivClasses?: number[][];
}

interface PlanRow { node_type: string; op: string; detail: string; physical: string | null }

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval('SELECT node_type, op, detail, physical FROM query_plan(?)', [sql])) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function physicalOf(rows: readonly PlanRow[], pred: (r: PlanRow) => boolean): PhysicalProps | undefined {
	const row = rows.find(pred);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

function fdHas(
	fds: PhysicalProps['fds'] | undefined,
	det: number[],
	dep: number[],
	unguardedOnly = true,
): boolean {
	if (!fds) return false;
	const detSet = new Set(det);
	return fds.some(fd => {
		if (unguardedOnly && fd.guard !== undefined) return false;
		if (fd.determinants.length !== det.length) return false;
		if (!fd.determinants.every(d => detSet.has(d))) return false;
		return dep.every(d => fd.dependents.includes(d));
	});
}

describe('Conditional FDs: end-to-end propagation', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const setupRegionTable = async (): Promise<void> => {
		await db.exec(
			"CREATE TABLE t (" +
			" id INTEGER PRIMARY KEY," +
			" customer_region TEXT NOT NULL," +
			" assigned_region TEXT NOT NULL," +
			" status TEXT NOT NULL," +
			" CHECK (status <> 'active' OR assigned_region = customer_region)" +
			") USING memory"
		);
	};

	it("table reference carries guarded FDs from the implication-form CHECK", async () => {
		await setupRegionTable();
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => /TABLEREF/i.test(r.op))
			?? physicalOf(rows, r => /SCAN/i.test(r.op));
		expect(props, 'expected table-ref physical props').to.not.equal(undefined);
		const guardedFd = props!.fds?.find(fd => fd.guard !== undefined);
		expect(guardedFd, 'expected a guarded FD on the source').to.not.equal(undefined);
	});

	it("filter with status='active' activates the guard: assigned_region determined by customer_region", async () => {
		await setupRegionTable();
		const rows = await planRows(db, "SELECT * FROM t WHERE status = 'active'");
		const filterProps = physicalOf(rows, r => r.op === 'FILTER');
		expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
		// Columns: id=0, customer_region=1, assigned_region=2, status=3.
		// After activation, the body FDs should appear UNGUARDED.
		expect(fdHas(filterProps!.fds, [1], [2])).to.equal(true);
		expect(fdHas(filterProps!.fds, [2], [1])).to.equal(true);
	});

	it("without status='active' the guarded FD does not activate", async () => {
		await setupRegionTable();
		// No WHERE clause — the table reference itself surfaces the guarded FD,
		// and no operator should expose the body FDs unguarded.
		const rows = await planRows(db, 'SELECT * FROM t');
		const anyUnguardedActivation = rows.some(r => {
			if (!r.physical) return false;
			const props = JSON.parse(r.physical) as PhysicalProps;
			return fdHas(props.fds, [1], [2]) || fdHas(props.fds, [2], [1]);
		});
		expect(anyUnguardedActivation, 'no node should have activated guard without status=active').to.equal(false);
	});

	describe('Partial UNIQUE → guarded FD', () => {
		const setupPartialUnique = async (): Promise<void> => {
			await db.exec(
				"CREATE TABLE p (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NOT NULL," +
				" status TEXT NOT NULL," +
				" region TEXT NOT NULL," +
				" amt INTEGER NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_p_active ON p(c) WHERE status = 'active'");
		};

		it("table reference carries a guarded FD with eq-literal guard on `status`", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, 'SELECT * FROM p');
			const props = physicalOf(rows, r => /TABLEREF/i.test(r.op))
				?? physicalOf(rows, r => /SCAN/i.test(r.op));
			expect(props, 'expected table-ref physical props').to.not.equal(undefined);
			// Columns: id=0, c=1, status=2, region=3, amt=4.
			const guardedFd = props!.fds?.find(fd =>
				fd.guard !== undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.guard.clauses.length === 1 &&
				fd.guard.clauses[0].kind === 'eq-literal' &&
				(fd.guard.clauses[0] as { kind: 'eq-literal'; column: number }).column === 2,
			);
			expect(guardedFd, 'expected guarded FD c → others with eq-literal status guard').to.not.equal(undefined);
		});

		it("filter with status='active' activates the guard: c → other-columns becomes unguarded", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, "SELECT * FROM p WHERE status = 'active'");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			// Columns: id=0, c=1, status=2, region=3, amt=4.
			// The activated FD's determinant is [1]; dependents should cover id/region/amt
			// (status is pinned by the filter binding and may be merged or split).
			const activated = filterProps!.fds?.find(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0) &&
				fd.dependents.includes(3) &&
				fd.dependents.includes(4),
			);
			expect(activated, 'expected activated unconditional FD c → others').to.not.equal(undefined);
		});

		it("filter with operand-flipped 'active' = status also activates the guard", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, "SELECT * FROM p WHERE 'active' = status");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const activated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.length > 0,
			);
			expect(activated, 'expected operand-flipped predicate to discharge the guard').to.equal(true);
		});

		it("filter with status='inactive' (wrong literal) does NOT activate the guard", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, "SELECT * FROM p WHERE status = 'inactive'");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const anyUnconditionalCKey = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(anyUnconditionalCKey ?? false, 'wrong filter must not activate guard').to.equal(false);
		});

		it("filter superset (status='active' AND amt > 5) still activates the guard", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, "SELECT * FROM p WHERE status = 'active' AND amt > 5");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const activated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(activated, 'extra conjuncts in filter are harmless to entailment').to.equal(true);
		});

		it("multi-conjunct partial predicate requires all conjuncts in the filter", async () => {
			await db.exec(
				"CREATE TABLE p2 (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NOT NULL," +
				" status TEXT NOT NULL," +
				" region TEXT NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_p2 ON p2(c) WHERE status = 'active' AND region = 'us'");

			// Both conjuncts present ⇒ activated.
			{
				const rows = await planRows(db, "SELECT * FROM p2 WHERE status = 'active' AND region = 'us'");
				const fp = physicalOf(rows, r => r.op === 'FILTER');
				expect(fp).to.not.equal(undefined);
				const activated = fp!.fds?.some(fd =>
					fd.guard === undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1 &&
					fd.dependents.includes(0),
				);
				expect(activated, 'matching multi-conjunct filter activates').to.equal(true);
			}

			// Single conjunct only ⇒ NOT activated (the other guard clause remains unsatisfied).
			{
				const rows = await planRows(db, "SELECT * FROM p2 WHERE status = 'active'");
				const fp = physicalOf(rows, r => r.op === 'FILTER');
				expect(fp).to.not.equal(undefined);
				const guardedSurvives = fp!.fds?.some(fd =>
					fd.guard !== undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1,
				);
				const wronglyActivated = fp!.fds?.some(fd =>
					fd.guard === undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1 &&
					fd.dependents.includes(0),
				);
				expect(wronglyActivated ?? false, 'partial entailment must not activate').to.equal(false);
				expect(guardedSurvives, 'guarded FD should still be present, waiting for a stronger filter').to.equal(true);
			}
		});

		it("nullable UC column suppresses the FD (NOT-NULL gate) — no guarded FD on the source", async () => {
			await db.exec(
				"CREATE TABLE pn (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NULL," +
				" status TEXT NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_pn ON pn(c) WHERE status = 'active'");
			const rows = await planRows(db, 'SELECT * FROM pn');
			const props = physicalOf(rows, r => /TABLEREF/i.test(r.op))
				?? physicalOf(rows, r => /SCAN/i.test(r.op));
			expect(props, 'expected table-ref physical props').to.not.equal(undefined);
			const partialFd = props!.fds?.find(fd =>
				fd.guard !== undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1,
			);
			expect(partialFd, 'NOT-NULL gate must suppress the partial-UC FD').to.equal(undefined);
		});
	});

	it("LEFT OUTER JOIN drops right-side guarded FDs", async () => {
		await db.exec("CREATE TABLE l (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec(
			"CREATE TABLE r (id INTEGER PRIMARY KEY, status TEXT, x TEXT, y TEXT," +
			" CHECK (status <> 'a' OR x = y)" +
			") USING memory"
		);
		const rows = await planRows(db, 'SELECT * FROM l LEFT JOIN r ON l.id = r.id');
		const joinProps =
			physicalOf(rows, r => r.op === 'HASHJOIN') ??
			physicalOf(rows, r => r.op === 'JOIN') ??
			physicalOf(rows, r => /JOIN/i.test(r.op));
		expect(joinProps, 'expected join physical props').to.not.equal(undefined);
		// No guarded FD from right's CHECK should survive in the join output.
		const surviving = joinProps!.fds?.filter(fd => fd.guard !== undefined) ?? [];
		expect(surviving).to.have.length(0);
	});
});
