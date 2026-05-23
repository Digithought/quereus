import { expect } from 'chai';
import {
	runUnionAll,
	runCrossProduct,
	cartesianProduct,
} from '../../src/runtime/emit/async-gather.js';
import { AsyncGatherNode } from '../../src/planner/nodes/async-gather-node.js';
import { PlanNode, type Attribute, type RelationalPlanNode, type PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { RelationType, ColRef, ColumnDef } from '../../src/common/datatype.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import { validatePhysicalTree } from '../../src/planner/validation/plan-validator.js';
import { QuereusError } from '../../src/common/errors.js';
import { RowContextMap, createRowSlot } from '../../src/runtime/context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../src/runtime/strict-fork.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { Row } from '../../src/common/types.js';
import type { RowDescriptor } from '../../src/planner/nodes/plan-node.js';

const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function makeRuntimeContext(): RuntimeContext {
	return {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: new RowContextMap(),
		tableContexts: new Map(),
		enableMetrics: false,
	};
}

function makeStrictRuntimeContext(): RuntimeContext {
	return {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: createStrictRowContextMap(),
		tableContexts: wrapTableContextsStrict(new Map()),
		enableMetrics: false,
	};
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

let attrIdCounter = 700000;
function makeAttr(name: string, sourceRelation = 'test.t'): Attribute {
	return {
		id: attrIdCounter++,
		name,
		type: {
			typeClass: 'scalar',
			logicalType: { name: 'TEXT', affinity: 'text' } as never,
			nullable: false,
			isReadOnly: false,
		},
		sourceRelation,
	};
}

/**
 * Minimal RelationalPlanNode mock for unit-testing AsyncGatherNode. Carries
 * a per-instance attribute list, column count, key list, and optional
 * physical-property override. The mock is a leaf — getChildren() returns
 * empty so validator traversal terminates here.
 */
class MockRelationalNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType: PlanNodeType = PlanNodeType.SeqScan;
	constructor(
		private readonly _attrs: readonly Attribute[],
		private readonly _keys: ColRef[][] = [],
		private readonly _physicalOverride: Partial<PhysicalProperties> = { deterministic: true, readonly: true },
		private readonly _columnsOverride?: ColumnDef[],
	) {
		super(mockScope, 0.1);
	}

	getType(): RelationType {
		const columns: ColumnDef[] = this._columnsOverride ?? this._attrs.map(a => ({
			name: a.name,
			type: a.type,
		}));
		return {
			typeClass: 'relation',
			columns,
			isSet: false,
			isReadOnly: true,
			keys: this._keys,
			rowConstraints: [],
		} as RelationType;
	}
	getAttributes(): readonly Attribute[] { return this._attrs; }
	getChildren(): readonly PlanNode[] { return []; }
	getRelations(): readonly RelationalPlanNode[] { return []; }
	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) throw new Error('mock relational has no children');
		return this;
	}
	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return this._physicalOverride;
	}
}

function rowSource(rows: Row[], delayMs = 0): (innerCtx: RuntimeContext) => AsyncIterable<Row> {
	return (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
		for (const r of rows) {
			if (delayMs > 0) await sleep(delayMs);
			yield r;
		}
	})();
}

describe('AsyncGather', () => {
	describe('node construction', () => {
		it('rejects N < 2 children', () => {
			expect(() => new AsyncGatherNode(mockScope, [], { kind: 'unionAll' }, 4))
				.to.throw(QuereusError, /requires >= 2/);
			const oneChild = new MockRelationalNode([makeAttr('c0')]);
			expect(() => new AsyncGatherNode(mockScope, [oneChild], { kind: 'unionAll' }, 4))
				.to.throw(QuereusError, /requires >= 2/);
		});

		it('rejects unionAll with mismatched column counts', () => {
			const left = new MockRelationalNode([makeAttr('a'), makeAttr('b')]);
			const right = new MockRelationalNode([makeAttr('x')]);
			expect(() => new AsyncGatherNode(mockScope, [left, right], { kind: 'unionAll' }, 4))
				.to.throw(QuereusError, /column count mismatch/);
		});

		it('rejects non-positive concurrencyCap', () => {
			const a = new MockRelationalNode([makeAttr('c0')]);
			const b = new MockRelationalNode([makeAttr('c0')]);
			expect(() => new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 0))
				.to.throw(QuereusError, /concurrencyCap/);
			expect(() => new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 1.5))
				.to.throw(QuereusError, /concurrencyCap/);
		});

		it('unionAll preserves children[0] attribute IDs', () => {
			const leftAttrs = [makeAttr('a'), makeAttr('b')];
			const left = new MockRelationalNode(leftAttrs);
			const right = new MockRelationalNode([makeAttr('x'), makeAttr('y')]);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'unionAll' }, 4);
			expect(node.getAttributes().map(a => a.id)).to.deep.equal(leftAttrs.map(a => a.id));
		});

		it('crossProduct concatenates children attributes verbatim', () => {
			const a = makeAttr('a'); const b = makeAttr('b');
			const x = makeAttr('x'); const y = makeAttr('y'); const z = makeAttr('z');
			const left = new MockRelationalNode([a, b]);
			const right = new MockRelationalNode([x, y, z]);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'crossProduct' }, 4);
			expect(node.getAttributes().map(a => a.id)).to.deep.equal([a.id, b.id, x.id, y.id, z.id]);
		});

		it('crossProduct keys are the Cartesian product of children keys', () => {
			const left = new MockRelationalNode([makeAttr('a'), makeAttr('b')], [[{ index: 0 }]]);
			const right = new MockRelationalNode([makeAttr('x'), makeAttr('y')], [[{ index: 0 }]]);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'crossProduct' }, 4);
			const keys = node.getType().keys;
			expect(keys).to.have.lengthOf(1);
			expect(keys[0].map(c => c.index)).to.deep.equal([0, 2]);
		});

		it('crossProduct keys are empty when any child has no key', () => {
			const left = new MockRelationalNode([makeAttr('a')], [[{ index: 0 }]]);
			const right = new MockRelationalNode([makeAttr('x')], []);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'crossProduct' }, 4);
			expect(node.getType().keys).to.deep.equal([]);
		});

		it('unionAll drops keys/FDs in physical properties', () => {
			const a = new MockRelationalNode(
				[makeAttr('c0')],
				[[{ index: 0 }]],
				{ deterministic: true, readonly: true, fds: [{ determinants: [], dependents: [0] }] },
			);
			const b = new MockRelationalNode(
				[makeAttr('c0')],
				[[{ index: 0 }]],
				{ deterministic: true, readonly: true, fds: [{ determinants: [], dependents: [0] }] },
			);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 4);
			const phys = node.physical;
			expect(phys.fds).to.equal(undefined);
			expect(phys.equivClasses).to.equal(undefined);
			expect(phys.constantBindings).to.equal(undefined);
			expect(phys.domainConstraints).to.equal(undefined);
			expect(phys.ordering).to.equal(undefined);
		});

		it('crossProduct folds child FDs with shifted column indices', () => {
			const a = new MockRelationalNode(
				[makeAttr('a0'), makeAttr('a1')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1] }] },
			);
			const b = new MockRelationalNode(
				[makeAttr('b0'), makeAttr('b1')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1] }] },
			);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'crossProduct' }, 4);
			const phys = node.physical;
			expect(phys.fds).to.not.equal(undefined);
			const fds = phys.fds!;
			// Expect FD on [0]→[1] (from a) and on [2]→[3] (from b, shifted by 2 cols).
			const has01 = fds.some(f => f.determinants.length === 1 && f.determinants[0] === 0 && f.dependents.includes(1));
			const has23 = fds.some(f => f.determinants.length === 1 && f.determinants[0] === 2 && f.dependents.includes(3));
			expect(has01).to.equal(true, 'left child FD must propagate');
			expect(has23).to.equal(true, 'right child FD must propagate with shifted indices');
		});

		it('withChildren arity-checks against original length', () => {
			const a = new MockRelationalNode([makeAttr('c0')]);
			const b = new MockRelationalNode([makeAttr('c0')]);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 4);
			expect(() => node.withChildren([a])).to.throw(QuereusError, /expects 2 children/);
		});

		it('withChildren returns this when children unchanged', () => {
			const a = new MockRelationalNode([makeAttr('c0')]);
			const b = new MockRelationalNode([makeAttr('c0')]);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 4);
			expect(node.withChildren([a, b])).to.equal(node);
		});

		it('withChildren rebuilds preserving combinator + cap + preserveAttributeIds', () => {
			const a = new MockRelationalNode([makeAttr('c0')]);
			const b = new MockRelationalNode([makeAttr('c0')]);
			const c = new MockRelationalNode([makeAttr('c0')]);
			const preserved = [makeAttr('preserved')];
			const node = new AsyncGatherNode(
				mockScope, [a, b], { kind: 'crossProduct' }, 7, preserved,
			);
			const rebuilt = node.withChildren([a, c]) as AsyncGatherNode;
			expect(rebuilt).to.not.equal(node);
			expect(rebuilt.combinator).to.deep.equal({ kind: 'crossProduct' });
			expect(rebuilt.concurrencyCap).to.equal(7);
			expect(rebuilt.preserveAttributeIds).to.equal(preserved);
		});
	});

	describe('validator pass-through', () => {
		it('passes full validation (attribute-preserving N-ary node)', () => {
			// AsyncGather is a physical node that forwards its children's attribute
			// IDs verbatim (crossProduct concatenates them). The attribute-provenance
			// surface recognizes this as forwarding, not duplication, so default
			// validation (validateAttributes: true) succeeds — no workaround needed.
			const leftA = makeAttr('a'); const leftB = makeAttr('b');
			const rightX = makeAttr('x'); const rightY = makeAttr('y');
			const left = new MockRelationalNode([leftA, leftB]);
			const right = new MockRelationalNode([rightX, rightY]);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'crossProduct' }, 4);
			expect(() => validatePhysicalTree(node)).to.not.throw();
		});
	});

	describe('unionAll runtime', () => {
		it('yields rows from every branch (multiset union)', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1], [2], [3]]),
				rowSource([[4], [5], [6]]),
				rowSource([[7], [8], [9]]),
			];
			const out = await collect(runUnionAll(ctx, factories, 4));
			expect(out.map(r => r[0]).sort((a, b) => (a as number) - (b as number))).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		});

		it('handles one empty branch', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1], [2]]),
				rowSource([]),
				rowSource([[5]]),
			];
			const out = await collect(runUnionAll(ctx, factories, 4));
			expect(out.map(r => r[0]).sort((a, b) => (a as number) - (b as number))).to.deep.equal([1, 2, 5]);
		});

		it('handles all-empty branches', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([]),
				rowSource([]),
			];
			const out = await collect(runUnionAll(ctx, factories, 4));
			expect(out).to.deep.equal([]);
		});

		it('drives branches concurrently with cap=N (~50ms for 3 branches × 50ms)', async () => {
			const ctx = makeRuntimeContext();
			const factories = [50, 50, 50].map(d => rowSource([[1]], d));
			const start = Date.now();
			const out = await collect(runUnionAll(ctx, factories, 3));
			const elapsed = Date.now() - start;
			expect(out).to.have.lengthOf(3);
			// One wave: 50ms target with broad jitter band.
			expect(elapsed).to.be.lessThan(175, `expected single wave, got ${elapsed}ms`);
		});

		it('cap=1 serializes branches (~150ms for 3 × 50ms)', async () => {
			const ctx = makeRuntimeContext();
			const factories = [50, 50, 50].map(d => rowSource([[1]], d));
			const start = Date.now();
			await collect(runUnionAll(ctx, factories, 1));
			const elapsed = Date.now() - start;
			expect(elapsed).to.be.greaterThan(125, `expected three serial waves, got ${elapsed}ms`);
		});

		it('concurrencyCap < N runs in waves (N=4, cap=2, ~100ms)', async () => {
			const ctx = makeRuntimeContext();
			const factories = [50, 50, 50, 50].map(d => rowSource([[1]], d));
			const start = Date.now();
			await collect(runUnionAll(ctx, factories, 2));
			const elapsed = Date.now() - start;
			expect(elapsed).to.be.greaterThan(75, `expected ~2 waves, got ${elapsed}ms`);
			expect(elapsed).to.be.lessThan(225, `expected ~2 waves, got ${elapsed}ms`);
		});

		it('outer ordering is not preserved (multiset, not list)', async () => {
			// Two branches each yielding [1,2,3] deterministically. The output
			// is required only to be the multiset {1,1,2,2,3,3}; we explicitly
			// do not assert it is `[1,1,2,2,3,3]`.
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1], [2], [3]]),
				rowSource([[1], [2], [3]]),
			];
			const out = await collect(runUnionAll(ctx, factories, 2));
			const sorted = out.map(r => r[0]).sort((a, b) => (a as number) - (b as number));
			expect(sorted).to.deep.equal([1, 1, 2, 2, 3, 3]);
		});

		it('closes all in-flight branches when the consumer breaks', async () => {
			const ctx = makeRuntimeContext();
			const returns = [false, false, false];
			const makeSlow = (i: number): (innerCtx: RuntimeContext) => AsyncIterable<Row> => {
				return (_inner: RuntimeContext): AsyncIterable<Row> => ({
					[Symbol.asyncIterator]() {
						let n = 0;
						return {
							async next(): Promise<IteratorResult<Row>> {
								await sleep(5);
								if (n >= 100) return { done: true, value: undefined as unknown as Row };
								return { done: false, value: [i, n++] as Row };
							},
							async return(): Promise<IteratorResult<Row>> {
								returns[i] = true;
								return { done: true, value: undefined as unknown as Row };
							},
						};
					},
				});
			};
			const factories = [makeSlow(0), makeSlow(1), makeSlow(2)];

			let count = 0;
			for await (const _r of runUnionAll(ctx, factories, 3)) {
				count++;
				if (count >= 1) break;
			}
			await sleep(20);
			expect(returns.every(r => r)).to.equal(true, `every branch must be return()-closed: ${returns}`);
		});

		it('propagates a branch throw and closes siblings', async () => {
			const ctx = makeRuntimeContext();
			const branchError = new Error('boom from branch 1');
			const throwingBranch = (_inner: RuntimeContext): AsyncIterable<Row> => ({
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<Row>> {
							await sleep(5);
							throw branchError;
						},
					};
				},
			});
			const factories = [
				rowSource([[0]]),
				throwingBranch,
				rowSource([[2]]),
			];
			let caught: unknown = undefined;
			try {
				await collect(runUnionAll(ctx, factories, 3));
			} catch (e) {
				caught = e;
			}
			expect(caught).to.equal(branchError);
		});

		describe('strict-fork interaction', () => {
			const strictMode = process.env.QUEREUS_FORK_STRICT === '1' || process.env.QUEREUS_FORK_STRICT === 'true';

			it('throws when parent mutates context while gather is live', function () {
				if (!strictMode) {
					this.skip();
					return;
				}
				const ctx = makeStrictRuntimeContext();
				const factories = [
					(_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
						yield [0] as Row;
						await sleep(10);
						yield [1] as Row;
					})(),
					rowSource([[2]]),
				];
				const attrId = 99001;
				const descriptor: RowDescriptor = [];
				descriptor[attrId] = 0;
				return (async () => {
					let caught: unknown = undefined;
					try {
						for await (const _r of runUnionAll(ctx, factories, 2)) {
							createRowSlot(ctx, descriptor);
						}
					} catch (e) {
						caught = e;
					}
					expect(caught, 'parent mutation while gather is live must violate strict-fork').to.not.equal(undefined);
					expect(String((caught as Error)?.message ?? caught)).to.match(/strict-fork/i);
				})();
			});
		});
	});

	describe('crossProduct runtime', () => {
		it('yields the full Cartesian product of two non-empty branches', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([['A'], ['B']]),
				rowSource([[1], [2]]),
			];
			const out = await collect(runCrossProduct(ctx, factories, 2));
			expect(out).to.have.lengthOf(4);
			const formatted = out.map(r => `${r[0]}-${r[1]}`).sort();
			expect(formatted).to.deep.equal(['A-1', 'A-2', 'B-1', 'B-2']);
		});

		it('an empty branch makes the product empty', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([['A'], ['B']]),
				rowSource([]),
			];
			const out = await collect(runCrossProduct(ctx, factories, 2));
			expect(out).to.deep.equal([]);
		});

		it('three branches of sizes 2/3/4 yield 24 rows', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([['a'], ['b']]),                 // 2
				rowSource([[1], [2], [3]]),                // 3
				rowSource([['x'], ['y'], ['z'], ['w']]),   // 4
			];
			const out = await collect(runCrossProduct(ctx, factories, 3));
			expect(out).to.have.lengthOf(24);
			// Every output row has 3 cells (one per branch).
			for (const r of out) expect(r).to.have.lengthOf(3);
			// Distinct rows: assert all 24 combinations are present exactly once.
			const set = new Set(out.map(r => r.join('|')));
			expect(set.size).to.equal(24);
		});

		it('drives the production phase concurrently (cap=3, 3 × 50ms ≈ 50ms)', async () => {
			const ctx = makeRuntimeContext();
			const factories = [50, 50, 50].map(d => rowSource([[1]], d));
			const start = Date.now();
			await collect(runCrossProduct(ctx, factories, 3));
			const elapsed = Date.now() - start;
			expect(elapsed).to.be.lessThan(175, `expected single concurrent wave, got ${elapsed}ms`);
		});

		it('cap=1 serializes production (3 × 50ms ≈ 150ms)', async () => {
			const ctx = makeRuntimeContext();
			const factories = [50, 50, 50].map(d => rowSource([[1]], d));
			const start = Date.now();
			await collect(runCrossProduct(ctx, factories, 1));
			const elapsed = Date.now() - start;
			expect(elapsed).to.be.greaterThan(125, `expected serial production, got ${elapsed}ms`);
		});
	});

	describe('cartesianProduct helper', () => {
		it('produces all combinations for 2x2', () => {
			const buffers: Row[][] = [[['A'], ['B']], [[1], [2]]];
			const out = Array.from(cartesianProduct(buffers));
			expect(out).to.have.lengthOf(4);
			expect(out.map(r => `${r[0]}-${r[1]}`).sort()).to.deep.equal(['A-1', 'A-2', 'B-1', 'B-2']);
		});

		it('produces 1 row when every buffer has one row', () => {
			const buffers: Row[][] = [[['x']], [[1]], [['z']]];
			const out = Array.from(cartesianProduct(buffers));
			expect(out).to.deep.equal([['x', 1, 'z']]);
		});
	});
});
