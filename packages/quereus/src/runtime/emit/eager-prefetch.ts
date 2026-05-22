import type { EagerPrefetchNode } from '../../planner/nodes/eager-prefetch-node.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { ParallelDriver, bumpParentForkCounter, dropParentForkCounter } from '../parallel-driver.js';

/**
 * Bounded promise-based prefetch buffer used by {@link emitEagerPrefetch}.
 *
 * Exactly one producer (the pump) and one consumer (the parent emit's
 * iterator) operate on this at a time, so a single nullable callback for each
 * direction is enough — no waiter queues required.
 *
 * Exported for unit-test access only.
 */
export class BoundedPrefetchBuffer<T> {
	private readonly queue: T[] = [];
	private done = false;
	private hasError = false;
	private error: unknown | undefined;
	private spaceWaiter: (() => void) | null = null;
	private itemWaiter: (() => void) | null = null;

	constructor(private readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(`BoundedPrefetchBuffer: capacity must be a positive integer, got ${capacity}`);
		}
	}

	get size(): number {
		return this.queue.length;
	}

	/**
	 * Push an item, awaiting space when the buffer is full. Returns false if
	 * the abort signal fired before space became available; otherwise true.
	 */
	async push(item: T, signal: AbortSignal): Promise<boolean> {
		while (this.queue.length >= this.capacity && !this.done && !this.hasError && !signal.aborted) {
			await new Promise<void>(resolve => {
				this.spaceWaiter = resolve;
				const onAbort = () => {
					const r = this.spaceWaiter;
					this.spaceWaiter = null;
					if (r) r();
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener('abort', onAbort, { once: true });
			});
		}
		if (signal.aborted || this.done || this.hasError) return false;
		this.queue.push(item);
		const w = this.itemWaiter;
		this.itemWaiter = null;
		if (w) w();
		return true;
	}

	/**
	 * Wait for an item, end-of-stream marker, or buffered error.
	 * Throws the cached error if {@link fail} was called.
	 */
	async shift(): Promise<{ done: true } | { done: false; value: T }> {
		while (this.queue.length === 0 && !this.done && !this.hasError) {
			await new Promise<void>(resolve => {
				this.itemWaiter = resolve;
			});
		}
		if (this.queue.length > 0) {
			const value = this.queue.shift() as T;
			const w = this.spaceWaiter;
			this.spaceWaiter = null;
			if (w) w();
			return { done: false, value };
		}
		if (this.hasError) {
			throw this.error;
		}
		return { done: true };
	}

	/** Mark end-of-stream; wakes a pending shifter. */
	close(): void {
		if (this.done || this.hasError) return;
		this.done = true;
		const w = this.itemWaiter;
		this.itemWaiter = null;
		if (w) w();
	}

	/** Record a producer error; wakes a pending shifter to throw it. */
	fail(err: unknown): void {
		if (this.done || this.hasError) return;
		this.hasError = true;
		this.error = err;
		const w = this.itemWaiter;
		this.itemWaiter = null;
		if (w) w();
	}
}

/**
 * Core prefetch async generator. Forks `rctx`, immediately starts a detached
 * pump that drains the child iterator into a bounded buffer, and yields rows
 * to the consumer from that buffer.
 *
 * Exported for unit testing — production callers go through {@link emitEagerPrefetch}.
 */
export async function* prefetchAsyncIterable(
	rctx: RuntimeContext,
	sourceCallback: (innerCtx: RuntimeContext) => AsyncIterable<Row>,
	bufferSize: number,
	driver: ParallelDriver = new ParallelDriver(),
): AsyncIterable<Row> {
	const [forkCtx] = driver.fork(rctx, 1);

	// Manually bump strict-fork bookkeeping (ParallelDriver.drive does this
	// internally, but we are using fork() directly).
	const parentTableState = bumpParentForkCounter(forkCtx.tableContexts);
	const parentRowState = bumpParentForkCounter(forkCtx.context);

	const childIter = sourceCallback(forkCtx)[Symbol.asyncIterator]();
	const buf = new BoundedPrefetchBuffer<Row>(bufferSize);
	const abort = new AbortController();

	const pump = (async () => {
		try {
			while (!abort.signal.aborted) {
				const r = await childIter.next();
				if (r.done) {
					buf.close();
					return;
				}
				const ok = await buf.push(r.value, abort.signal);
				if (!ok) return;
			}
		} catch (e) {
			buf.fail(e);
		}
	})();
	// Detach; awaited in finally for clean shutdown.
	void pump;

	try {
		while (true) {
			const item = await buf.shift();
			if (item.done) return;
			yield item.value;
		}
	} finally {
		abort.abort();
		buf.close();
		try {
			await childIter.return?.(undefined);
		} catch {
			// Swallow — already in cleanup.
		}
		await pump.catch(() => undefined);
		dropParentForkCounter(parentTableState);
		dropParentForkCounter(parentRowState);
	}
}

/**
 * Emit an EagerPrefetchNode: forks the runtime context, immediately starts
 * pumping the child sub-tree into a bounded buffer, and yields rows from that
 * buffer to the parent emit.
 *
 * The body is an async generator, so the pump only starts on first `next()`.
 */
export function emitEagerPrefetch(plan: EagerPrefetchNode, ctx: EmissionContext): Instruction {
	const driver = new ParallelDriver();
	const bufferSize = plan.bufferSize;

	function run(
		rctx: RuntimeContext,
		sourceCallback: (innerCtx: RuntimeContext) => AsyncIterable<Row>,
	): AsyncIterable<Row> {
		return prefetchAsyncIterable(rctx, sourceCallback, bufferSize, driver);
	}

	const sourceInstruction = emitCallFromPlan(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `eager_prefetch(buffer=${bufferSize})`,
	};
}
