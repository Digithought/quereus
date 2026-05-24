import { expect } from 'chai';
import { prefetchAsyncIterable, BoundedPrefetchBuffer } from '../../src/runtime/emit/eager-prefetch.js';
import { RowContextMap, createRowSlot } from '../../src/runtime/context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../src/runtime/strict-fork.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { Row } from '../../src/common/types.js';
import type { RowDescriptor } from '../../src/planner/nodes/plan-node.js';

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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('EagerPrefetch', () => {
	describe('pass-through equivalence', () => {
		it('yields rows in order', async () => {
			const rows: Row[] = [['A'], ['B'], ['C'], ['D'], ['E']];
			const ctx = makeRuntimeContext();
			const source = async function* (_inner: RuntimeContext): AsyncIterable<Row> {
				for (const r of rows) yield r;
			};

			const out = await collect(prefetchAsyncIterable(ctx, source, 8));
			expect(out).to.deep.equal(rows);
		});

		it('empty source yields nothing and completes', async () => {
			const ctx = makeRuntimeContext();
			const source = async function* (_inner: RuntimeContext): AsyncIterable<Row> {
				// no rows
			};

			const out = await collect(prefetchAsyncIterable(ctx, source, 4));
			expect(out).to.deep.equal([]);
		});
	});

	describe('eager start', () => {
		it('starts the source on construction, before any iter.next()', async () => {
			const ctx = makeRuntimeContext();
			let started = false;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				started = true;
				yield ['first'] as Row;
				yield ['second'] as Row;
			})();

			// EAGER contract: building the iterable forks and starts the pump
			// immediately. The pump's first `childIter.next()` runs the source's
			// body synchronously up to its first yield — so `started` flips to
			// true at construction time, before any consumer `.next()`.
			const iterable = prefetchAsyncIterable(ctx, source, 4);
			expect(started).to.equal(true, 'pump must start the source eagerly on construction');

			const iter = iterable[Symbol.asyncIterator]();
			const r = await iter.next();
			expect(r.value).to.deep.equal(['first']);

			// Drain to allow cleanup.
			await iter.next();
			await iter.next();
		});

		it('pre-fetches additional rows while the consumer is busy elsewhere', async () => {
			const ctx = makeRuntimeContext();
			let yielded = 0;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				for (let i = 0; i < 5; i++) {
					yielded++;
					yield [i] as Row;
				}
			})();

			const iter = prefetchAsyncIterable(ctx, source, 8)[Symbol.asyncIterator]();
			// Trigger the pump and immediately consume one row.
			const first = await iter.next();
			expect(first.value).to.deep.equal([0]);

			// Simulate the consumer being busy. The pump should keep filling the buffer.
			await sleep(20);
			// With a buffer of 8 and 5 total rows, the pump should have pulled them all by now.
			expect(yielded).to.equal(5, `pump did not pre-fetch: only ${yielded} of 5 rows yielded`);

			// Cleanup.
			await iter.return?.();
		});
	});

	describe('build/probe overlap (the headline win)', () => {
		it("starts the probe's first fetch during the build window, not after it", async () => {
			// Mirrors a BloomJoin: the consumer drains the "build" (a sleep) to
			// completion before touching the probe. With eager-on-construction the
			// probe's first network round-trip is already in flight while the build
			// materializes; with the old lazy behavior it would not fire until the
			// drain below begins (i.e. at ~buildMs).
			const ctx = makeRuntimeContext();
			const buildMs = 80;
			const t0 = Date.now();
			let firstFetchAt = -1;
			const probeSource = (_inner: RuntimeContext): AsyncIterable<Row> => ({
				[Symbol.asyncIterator]() {
					let i = 0;
					return {
						async next(): Promise<IteratorResult<Row>> {
							if (firstFetchAt < 0) firstFetchAt = Date.now() - t0;
							await sleep(5);
							if (i >= 3) return { done: true, value: undefined as unknown as Row };
							return { done: false, value: [i++] as Row };
						},
					};
				},
			});

			// Construct the prefetch — the pump starts now. Then simulate the slow
			// build phase before draining the probe.
			const iter = prefetchAsyncIterable(ctx, probeSource, 8)[Symbol.asyncIterator]();
			await sleep(buildMs);

			const out: Row[] = [];
			while (true) {
				const r = await iter.next();
				if (r.done) break;
				out.push(r.value);
			}

			expect(out).to.deep.equal([[0], [1], [2]]);
			// Headline assertion: the probe's first fetch landed DURING the build
			// window (well before it completed), proving the overlap. Wide CI band
			// matching the other parallel wall-clock tests.
			expect(firstFetchAt).to.be.greaterThanOrEqual(0, 'probe must have fetched');
			expect(firstFetchAt).to.be.lessThan(buildMs / 2,
				`probe first-fetch should overlap the build window (~0ms), got ${firstFetchAt}ms of a ${buildMs}ms build`);
		});
	});

	describe('back-pressure / bounded buffer', () => {
		it('producer pauses when buffer fills and no one is consuming', async () => {
			const ctx = makeRuntimeContext();
			const bufferSize = 3;
			// "Infinite-ish" fast source.
			let produced = 0;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				for (let i = 0; i < 1_000_000; i++) {
					produced++;
					yield [i] as Row;
				}
			})();

			const iter = prefetchAsyncIterable(ctx, source, bufferSize)[Symbol.asyncIterator]();
			// Trigger the pump by demanding the first row, then back off and let the
			// pump race the source. With no further consumer demand the pump must
			// stop after filling the buffer.
			const first = await iter.next();
			expect(first.done).to.equal(false);
			await sleep(50);

			// Pump can hold at most: 1 row already delivered to consumer + bufferSize
			// rows in the buffer + 1 row in flight pulled from source but not yet pushed.
			expect(produced).to.be.at.most(bufferSize + 2,
				`pump ran away: produced=${produced}, buffer=${bufferSize}`);

			// Consume one more; pump should advance by ~1.
			const producedSnapshot = produced;
			await iter.next();
			await sleep(20);
			expect(produced).to.be.greaterThan(producedSnapshot,
				'consuming a row should let the pump advance');
			expect(produced).to.be.at.most(bufferSize + 4,
				`after one shift, pump should advance by ~1, not unbounded: produced=${produced}`);

			// Cleanup: cancel the infinite stream.
			await iter.return?.();
		});
	});

	describe('consumer break', () => {
		it("calls the child iterator's return() when the consumer breaks early", async () => {
			const ctx = makeRuntimeContext();
			let returnCalled = false;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => ({
				[Symbol.asyncIterator]() {
					let i = 0;
					return {
						async next(): Promise<IteratorResult<Row>> {
							if (i >= 10) return { done: true, value: undefined as unknown as Row };
							return { done: false, value: [i++] as Row };
						},
						async return(): Promise<IteratorResult<Row>> {
							returnCalled = true;
							return { done: true, value: undefined as unknown as Row };
						},
					};
				},
			});

			let count = 0;
			for await (const _r of prefetchAsyncIterable(ctx, source, 4)) {
				count++;
				if (count >= 2) break;
			}

			// Give the finally block a tick to run the cleanup.
			await sleep(20);
			expect(returnCalled).to.equal(true, "child iterator's return() must be called");
		});

		it('no unhandled rejection after consumer break', async () => {
			const unhandled: unknown[] = [];
			const handler = (reason: unknown) => unhandled.push(reason);
			process.on('unhandledRejection', handler);
			try {
				const ctx = makeRuntimeContext();
				const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
					for (let i = 0; i < 100; i++) {
						await sleep(1);
						yield [i] as Row;
					}
				})();

				let count = 0;
				for await (const _r of prefetchAsyncIterable(ctx, source, 4)) {
					count++;
					if (count >= 2) break;
				}
				await sleep(40);
				expect(unhandled).to.have.lengthOf(0, `got unhandled rejections: ${unhandled.map(String).join(', ')}`);
			} finally {
				process.off('unhandledRejection', handler);
			}
		});
	});

	describe('inner throw', () => {
		it('propagates the source error to the consumer with identity preserved', async () => {
			const ctx = makeRuntimeContext();
			const sourceError = new Error('boom at row 3');
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				yield [0] as Row;
				yield [1] as Row;
				yield [2] as Row;
				throw sourceError;
			})();

			let caught: unknown = undefined;
			const seen: Row[] = [];
			try {
				for await (const r of prefetchAsyncIterable(ctx, source, 8)) {
					seen.push(r);
				}
			} catch (e) {
				caught = e;
			}
			expect(caught).to.equal(sourceError);
			// At minimum the consumer eventually sees the error; rows up through row 2
			// may or may not have been delivered before the throw propagates.
			expect(seen.length).to.be.at.most(3);
		});
	});

	describe('cancellation via consumer error path', () => {
		it("closes the child iterator when the consumer's body throws", async () => {
			const ctx = makeRuntimeContext();
			let returnCalled = false;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => ({
				[Symbol.asyncIterator]() {
					let i = 0;
					return {
						async next(): Promise<IteratorResult<Row>> {
							await sleep(2);
							if (i >= 50) return { done: true, value: undefined as unknown as Row };
							return { done: false, value: [i++] as Row };
						},
						async return(): Promise<IteratorResult<Row>> {
							returnCalled = true;
							return { done: true, value: undefined as unknown as Row };
						},
					};
				},
			});

			const consumerError = new Error('consumer aborted');
			let caught: unknown = undefined;
			try {
				for await (const _r of prefetchAsyncIterable(ctx, source, 4)) {
					throw consumerError;
				}
			} catch (e) {
				caught = e;
			}
			expect(caught).to.equal(consumerError);
			await sleep(20);
			expect(returnCalled).to.equal(true, "child iterator's return() must run after consumer throw");
		});
	});

	describe('strict-fork interaction', () => {
		const strictMode = process.env.QUEREUS_FORK_STRICT === '1' || process.env.QUEREUS_FORK_STRICT === 'true';

		it('throws when the parent mutates context while the prefetch is live', function () {
			if (!strictMode) {
				this.skip();
				return;
			}

			const ctx = makeStrictRuntimeContext();
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				yield [0] as Row;
				await sleep(10);
				yield [1] as Row;
			})();

			const attrId = 1234;
			const descriptor: RowDescriptor = [];
			descriptor[attrId] = 0;

			return (async () => {
				let caught: unknown = undefined;
				try {
					for await (const _ of prefetchAsyncIterable(ctx, source, 4)) {
						// Mutate the parent's row context while the fork is live.
						createRowSlot(ctx, descriptor);
					}
				} catch (e) {
					caught = e;
				}
				expect(caught, 'parent mutation while prefetch is live must violate strict-fork').to.not.equal(undefined);
				expect(String((caught as Error)?.message ?? caught)).to.match(/strict-fork/i);
			})();
		});

		it('allows parent mutation after the prefetch finishes', function () {
			if (!strictMode) {
				this.skip();
				return;
			}

			const ctx = makeStrictRuntimeContext();
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				yield [0] as Row;
			})();

			return (async () => {
				for await (const _ of prefetchAsyncIterable(ctx, source, 4)) { /* drain */ }
				// Parent activeForks should be 0 again.
				expect(() => {
					ctx.tableContexts.set({} as never, () => undefined as never);
				}).to.not.throw();
			})();
		});
	});

	describe('eager construction', () => {
		it('starts the source on construction even if the iterable is never iterated', async () => {
			const ctx = makeRuntimeContext();
			let started = false;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				started = true;
				yield [0] as Row;
			})();

			// EAGER contract (inverted from the old lazy behavior): building the
			// iterable starts the pump immediately, so the source runs without any
			// consumer demand. The pump fills the buffer then would block on
			// back-pressure, so we must close it to avoid a dangling fork.
			const iterable = prefetchAsyncIterable(ctx, source, 4);
			await sleep(15);
			expect(started).to.equal(true, 'source must start eagerly on construction');

			// Clean up the now-running pump.
			await iterable[Symbol.asyncIterator]().return?.(undefined);
		});
	});

	describe('BoundedPrefetchBuffer (internal helper)', () => {
		it('rejects non-positive capacity', () => {
			expect(() => new BoundedPrefetchBuffer<number>(0)).to.throw(RangeError);
			expect(() => new BoundedPrefetchBuffer<number>(-1)).to.throw(RangeError);
			expect(() => new BoundedPrefetchBuffer<number>(1.5)).to.throw(RangeError);
		});

		it('shift returns done after close on an empty buffer', async () => {
			const buf = new BoundedPrefetchBuffer<number>(2);
			buf.close();
			const r = await buf.shift();
			expect(r.done).to.equal(true);
		});

		it('shift drains queued items even after close', async () => {
			const buf = new BoundedPrefetchBuffer<number>(4);
			const ctl = new AbortController();
			await buf.push(1, ctl.signal);
			await buf.push(2, ctl.signal);
			buf.close();
			const a = await buf.shift();
			const b = await buf.shift();
			const c = await buf.shift();
			expect(a).to.deep.equal({ done: false, value: 1 });
			expect(b).to.deep.equal({ done: false, value: 2 });
			expect(c).to.deep.equal({ done: true });
		});

		it('shift throws on fail() with the cached error identity', async () => {
			const buf = new BoundedPrefetchBuffer<number>(2);
			const err = new Error('producer failure');
			buf.fail(err);
			let caught: unknown = undefined;
			try { await buf.shift(); } catch (e) { caught = e; }
			expect(caught).to.equal(err);
		});
	});
});
