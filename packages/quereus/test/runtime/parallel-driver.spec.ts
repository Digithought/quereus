import { expect } from 'chai';
import { ParallelDriver } from '../../src/runtime/parallel-driver.js';
import { RowContextMap, createRowSlot } from '../../src/runtime/context-helpers.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { RowDescriptor } from '../../src/planner/nodes/plan-node.js';
import type { Row } from '../../src/common/types.js';

/**
 * Build a minimal RuntimeContext suitable for the primitive's own unit tests.
 * The fields downstream of `context` / `tableContexts` are intentionally stubs —
 * ParallelDriver only reads structural fields and forwards everything else.
 */
function makeRuntimeContext(): RuntimeContext {
	return {
		// `db` / `stmt` are unused by the primitive itself; cast through unknown.
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: new RowContextMap(),
		tableContexts: new Map(),
		enableMetrics: false,
	};
}

interface MockSourceOptions {
	/** Number of rows to produce before completing. */
	rows: number;
	/** Delay in ms before each yield. */
	delayMs?: number;
	/** Row index (0-based) at which to throw instead of yielding. */
	throwAtRow?: number;
	/** Error to throw if `throwAtRow` triggers; default: a fresh Error. */
	throwError?: Error;
	/** Records iterator-lifecycle events for later assertion. */
	hooks?: {
		onStart?: () => void;
		onReturn?: () => void;
		onError?: (err: unknown) => void;
		onComplete?: () => void;
	};
}

/**
 * Async generator-based mock source. Each pre-yield delay simulates async I/O,
 * `throwAtRow` injects a deterministic failure, and `hooks` lets the test verify
 * that the iterator's `return()` was called on cancellation.
 */
function mockSource(opts: MockSourceOptions): (ctx: RuntimeContext) => AsyncIterable<Row> {
	return (_ctx: RuntimeContext): AsyncIterable<Row> => {
		return (async function* () {
			opts.hooks?.onStart?.();
			let completedNormally = false;
			try {
				for (let i = 0; i < opts.rows; i++) {
					if (opts.delayMs && opts.delayMs > 0) {
						await new Promise(r => setTimeout(r, opts.delayMs));
					}
					if (opts.throwAtRow !== undefined && i === opts.throwAtRow) {
						const err = opts.throwError ?? new Error(`mock source threw at row ${i}`);
						opts.hooks?.onError?.(err);
						throw err;
					}
					yield [i] as Row;
				}
				completedNormally = true;
				opts.hooks?.onComplete?.();
			} finally {
				// `onReturn` fires only when the generator's finally is triggered by
				// something other than natural completion — i.e. an upstream return()
				// or an in-iterator throw.
				if (!completedNormally) {
					opts.hooks?.onReturn?.();
				}
			}
		})();
	};
}

/** Collect all driven items into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

describe('ParallelDriver', () => {
	describe('fork()', () => {
		it('produces n independent contexts', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 3);

			expect(forks).to.have.lengthOf(3);
			for (const fork of forks) {
				expect(fork).to.not.equal(parent);
				expect(fork.context).to.not.equal(parent.context);
				expect(fork.tableContexts).to.not.equal(parent.tableContexts);
			}
			// Sibling identities differ pairwise.
			expect(forks[0].context).to.not.equal(forks[1].context);
			expect(forks[0].tableContexts).to.not.equal(forks[1].tableContexts);
		});

		it('shares read-only fields by reference', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			parent.params = { 1: 42 };
			const forks = driver.fork(parent, 2);

			expect(forks[0].db).to.equal(parent.db);
			expect(forks[0].stmt).to.equal(parent.stmt);
			expect(forks[0].params).to.equal(parent.params);
			expect(forks[0].enableMetrics).to.equal(parent.enableMetrics);
		});

		it('writes via createRowSlot in one fork are invisible to siblings', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 2);

			const attrId = 100;
			const descriptor: RowDescriptor = [];
			descriptor[attrId] = 0;

			const slot0 = createRowSlot(forks[0], descriptor);
			const slot1 = createRowSlot(forks[1], descriptor);
			slot0.set(['A'] as unknown as Row);
			slot1.set(['B'] as unknown as Row);

			// Each fork's attribute index resolves to its own slot's row.
			const entry0 = forks[0].context.attributeIndex[attrId];
			const entry1 = forks[1].context.attributeIndex[attrId];
			expect(entry0).to.not.equal(undefined);
			expect(entry1).to.not.equal(undefined);
			expect(entry0!.rowGetter()).to.deep.equal(['A']);
			expect(entry1!.rowGetter()).to.deep.equal(['B']);

			slot0.close();
			slot1.close();
		});

		it('parent context.size is unchanged after fork lifecycle', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const beforeSize = parent.context.size;
			const beforeTableSize = parent.tableContexts.size;

			const forks = driver.fork(parent, 3);

			const attrId = 200;
			const descriptor: RowDescriptor = [];
			descriptor[attrId] = 0;

			// Exercise the forks: set and close slots in each.
			const slots = forks.map(f => createRowSlot(f, descriptor));
			for (const s of slots) s.set(['x'] as unknown as Row);
			for (const s of slots) s.close();

			expect(parent.context.size).to.equal(beforeSize);
			expect(parent.tableContexts.size).to.equal(beforeTableSize);
		});

		it('rejects negative or non-integer n', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			expect(() => driver.fork(parent, -1)).to.throw(RangeError);
			expect(() => driver.fork(parent, 1.5)).to.throw(RangeError);
		});

		it('n = 0 returns an empty array', () => {
			const driver = new ParallelDriver();
			expect(driver.fork(makeRuntimeContext(), 0)).to.deep.equal([]);
		});

		it('preserves parent-seeded attributes in every fork, then isolates fork-local overrides', () => {
			// Seed the parent with a slot BEFORE forking — the snapshot loop must rebuild
			// the child's attributeIndex from this entry so a fork-local read sees it.
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();

			const outerAttrId = 300;
			const outerDescriptor: RowDescriptor = [];
			outerDescriptor[outerAttrId] = 0;
			const parentSlot = createRowSlot(parent, outerDescriptor);
			parentSlot.set(['outer'] as unknown as Row);

			const forks = driver.fork(parent, 2);

			// Every fork resolves the outer attribute via its own attributeIndex
			// (proves the snapshot re-driving rebuilt the index correctly).
			for (const fork of forks) {
				const entry = fork.context.attributeIndex[outerAttrId];
				expect(entry, 'fork must have outer attribute in its index').to.not.equal(undefined);
				expect(entry!.rowGetter()).to.deep.equal(['outer']);
			}

			// A fork-local override of the same descriptor must not affect siblings
			// or the parent (proves descriptor identity is preserved across the snapshot,
			// so `RowContextMap.set` updates the fork's *existing* entry rather than
			// adding a parallel one).
			const fork0Slot = createRowSlot(forks[0], outerDescriptor);
			fork0Slot.set(['fork0-override'] as unknown as Row);

			expect(forks[0].context.attributeIndex[outerAttrId]!.rowGetter()).to.deep.equal(['fork0-override']);
			expect(forks[1].context.attributeIndex[outerAttrId]!.rowGetter()).to.deep.equal(['outer']);
			expect(parent.context.attributeIndex[outerAttrId]!.rowGetter()).to.deep.equal(['outer']);

			// Fork-local close removes the override from the fork but parent retains its slot.
			fork0Slot.close();
			expect(forks[0].context.attributeIndex[outerAttrId]).to.equal(undefined);
			expect(parent.context.attributeIndex[outerAttrId]!.rowGetter()).to.deep.equal(['outer']);

			parentSlot.close();
		});
	});

	describe('drive() — concurrency', () => {
		it('runs branches in parallel by default (unbounded concurrency)', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 4);
			const factories = [50, 50, 50, 50].map(d => mockSource({ rows: 1, delayMs: d }));

			const start = Date.now();
			const items = await collect(driver.drive(factories, forks));
			const elapsed = Date.now() - start;

			expect(items).to.have.lengthOf(4);
			// Loose upper bound — wide enough to absorb timer / CI jitter while still
			// proving the four 50ms waits ran in parallel (which would otherwise total ~200ms).
			expect(elapsed).to.be.lessThan(150, `expected parallel run, got ${elapsed}ms`);
			expect(items.map(i => i.branch).sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 3]);
		});

		it('respects concurrency cap', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 4);
			const factories = [50, 50, 50, 50].map(d => mockSource({ rows: 1, delayMs: d }));

			const start = Date.now();
			const items = await collect(driver.drive(factories, forks, { concurrency: 2 }));
			const elapsed = Date.now() - start;

			expect(items).to.have.lengthOf(4);
			// concurrency=2 means two waves of two 50ms sleeps → roughly 100ms.
			// Tolerance band: between one wave (50ms) and four waves (200ms), exclusive.
			expect(elapsed).to.be.greaterThan(75, `expected ~2 waves, got ${elapsed}ms`);
			expect(elapsed).to.be.lessThan(175, `expected ~2 waves, got ${elapsed}ms`);
		});
	});

	describe('drive() — cancellation', () => {
		it('cancels remaining branches and rejects with the original error', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 4);

			const returns = [false, false, false, false];
			const sourceError = new Error('branch 1 boom');

			const factories = [
				mockSource({ rows: 5, delayMs: 20, hooks: { onReturn: () => { returns[0] = true; } } }),
				mockSource({
					rows: 5, delayMs: 20, throwAtRow: 2, throwError: sourceError,
					hooks: { onReturn: () => { returns[1] = true; } },
				}),
				mockSource({ rows: 5, delayMs: 20, hooks: { onReturn: () => { returns[2] = true; } } }),
				mockSource({ rows: 5, delayMs: 20, hooks: { onReturn: () => { returns[3] = true; } } }),
			];

			let caught: unknown = undefined;
			try {
				await collect(driver.drive(factories, forks));
			} catch (e) {
				caught = e;
			}

			expect(caught).to.equal(sourceError);
			// Branch 1 threw — its iterator's finally still fires, so returns[1] is true.
			// The critical assertion is that branches 0/2/3 also got return()-closed.
			expect(returns[0]).to.equal(true, 'branch 0 should be return()-closed');
			expect(returns[2]).to.equal(true, 'branch 2 should be return()-closed');
			expect(returns[3]).to.equal(true, 'branch 3 should be return()-closed');
		});

		it('closes every active branch when the consumer breaks early', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 3);

			const returns = [false, false, false];
			const factories = [0, 1, 2].map(i =>
				mockSource({
					rows: 10, delayMs: 10,
					hooks: { onReturn: () => { returns[i] = true; } },
				}),
			);

			let count = 0;
			for await (const _item of driver.drive(factories, forks)) {
				count++;
				if (count >= 2) break;
			}

			// After break, every active branch should have been return()-closed.
			expect(returns[0]).to.equal(true);
			expect(returns[1]).to.equal(true);
			expect(returns[2]).to.equal(true);
		});

		it('pre-aborted signal rejects without invoking any factory', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 3);

			let started = 0;
			const factories = [0, 1, 2].map(() =>
				mockSource({
					rows: 1, delayMs: 0,
					hooks: { onStart: () => { started++; } },
				}),
			);

			const controller = new AbortController();
			controller.abort();

			let caught: unknown = undefined;
			try {
				await collect(driver.drive(factories, forks, { signal: controller.signal }));
			} catch (e) {
				caught = e;
			}

			expect(caught).to.not.equal(undefined, 'drive() must reject');
			expect(started).to.equal(0, 'no factory should have been invoked');
		});
	});
});
