import type { RuntimeContext } from './types.js';
import { RowContextMap } from './context-helpers.js';

/**
 * Options controlling {@link ParallelDriver.drive} execution.
 */
export interface ParallelDriveOptions {
	/** Maximum number of concurrently-active branches. Defaults to `factories.length`. */
	concurrency?: number;
	/** Cooperative cancellation. Firing aborts all branches. */
	signal?: AbortSignal;
}

/** Pair yielded by {@link ParallelDriver.drive}: a value plus the branch index that produced it. */
export interface ParallelDriveItem<T> {
	readonly branch: number;
	readonly value: T;
}

/**
 * Runtime helper that forks a {@link RuntimeContext} into N independent child views
 * and drives N branch factories concurrently with bounded concurrency and cooperative
 * cancellation.
 *
 * This is a foundation primitive — it has no SQL/plan-node consumers yet. Combinator
 * choice (gather, merge-by-key, zip, lookup-join, ...) is left to downstream nodes;
 * {@link drive} yields `{ branch, value }` pairs in arrival order so a consumer can
 * impose whatever combinator it needs on top.
 */
export class ParallelDriver {
	/**
	 * Fork `rctx` into `n` independent child views.
	 *
	 * Each child receives:
	 * - an **independent** {@link RowContextMap} seeded with a snapshot of the parent's
	 *   entries — writes (e.g. via `createRowSlot`) in one fork do not leak to siblings
	 *   or to the parent;
	 * - an **independent** `tableContexts` map seeded with a shallow snapshot of the
	 *   parent's entries — set/delete in one fork do not leak to siblings or parent;
	 * - **shared** references to read-mostly state: `db`, `stmt`, `params`,
	 *   `enableMetrics`, `tracer`, `activeConnection`, `contextTracker`, `planStack`.
	 *
	 * The parent is treated as immutable for the lifetime of the forks.
	 */
	fork(rctx: RuntimeContext, n: number): RuntimeContext[] {
		if (n < 0 || !Number.isInteger(n)) {
			throw new RangeError(`ParallelDriver.fork: n must be a non-negative integer, got ${n}`);
		}
		const forks: RuntimeContext[] = new Array(n);
		for (let i = 0; i < n; i++) {
			const childContext = new RowContextMap();
			for (const [desc, getter] of rctx.context.entries()) {
				childContext.set(desc, getter);
			}
			forks[i] = {
				db: rctx.db,
				stmt: rctx.stmt,
				params: rctx.params,
				context: childContext,
				tableContexts: new Map(rctx.tableContexts),
				tracer: rctx.tracer,
				activeConnection: rctx.activeConnection,
				enableMetrics: rctx.enableMetrics,
				contextTracker: rctx.contextTracker,
				planStack: rctx.planStack,
			};
		}
		return forks;
	}

	/**
	 * Drive `factories` concurrently, each invoked with its paired fork from `forks`,
	 * and yield every produced value as `{ branch, value }` in arrival order.
	 *
	 * Concurrency is capped at `opts.concurrency` (default: `factories.length`); a
	 * new branch is started only when an in-flight branch completes.
	 *
	 * If any branch's iterator throws, the original error is re-raised after every
	 * other in-flight iterator has been best-effort `return()`-closed.
	 *
	 * Cancellation is cooperative via `opts.signal`:
	 * - A pre-aborted signal causes `drive()` to throw before any factory is invoked.
	 * - An abort fired mid-stream interrupts the next race step, then closes branches.
	 *
	 * When the consumer breaks out of the `for-await` loop, the async generator's
	 * `return()` runs the same close-all path on every active branch.
	 */
	drive<T>(
		factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<T>>,
		forks: ReadonlyArray<RuntimeContext>,
		opts?: ParallelDriveOptions,
	): AsyncIterable<ParallelDriveItem<T>> {
		if (factories.length !== forks.length) {
			throw new RangeError(
				`ParallelDriver.drive: factories.length (${factories.length}) !== forks.length (${forks.length})`,
			);
		}
		return driveImpl(factories, forks, opts);
	}
}

const ABORT_SENTINEL: unique symbol = Symbol('quereus.parallel-driver.abort');
type AbortSentinel = typeof ABORT_SENTINEL;

interface BranchPullResult<T> {
	branch: number;
	result: IteratorResult<T>;
	/** True iff the iterator threw; `error` then carries the thrown value (which may itself be `undefined`). */
	hadError: boolean;
	error: unknown;
}

async function* driveImpl<T>(
	factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<T>>,
	forks: ReadonlyArray<RuntimeContext>,
	opts: ParallelDriveOptions | undefined,
): AsyncIterable<ParallelDriveItem<T>> {
	const signal = opts?.signal;

	// Pre-aborted: throw before invoking any factory.
	if (signal?.aborted) {
		throw signalReason(signal);
	}

	if (factories.length === 0) return;

	const concurrency = Math.max(1, opts?.concurrency ?? factories.length);
	const branchCount = factories.length;

	type BranchState = 'not-started' | 'pulling' | 'done';
	const iterators: Array<AsyncIterator<T> | null> = new Array(branchCount).fill(null);
	const branchStates: BranchState[] = new Array(branchCount).fill('not-started');
	const pendingPulls = new Map<number, Promise<BranchPullResult<T>>>();

	let nextToStart = 0;
	let activePulling = 0;
	let aborted = false;
	let abortReason: unknown = undefined;

	// Build a never-rejecting promise that resolves to ABORT_SENTINEL on signal abort.
	let onAbort: (() => void) | null = null;
	const abortPromise = new Promise<AbortSentinel>((resolve) => {
		if (!signal) return; // never resolves — fine inside Promise.race
		onAbort = () => {
			if (!aborted) {
				aborted = true;
				abortReason = signalReason(signal);
			}
			resolve(ABORT_SENTINEL);
		};
		signal.addEventListener('abort', onAbort);
	});

	const schedulePull = (i: number): void => {
		if (branchStates[i] === 'done') return;
		const it = iterators[i]!;
		const promise: Promise<BranchPullResult<T>> = (async () => {
			try {
				const result = await it.next();
				return { branch: i, result, hadError: false, error: undefined };
			} catch (error) {
				return {
					branch: i,
					result: { value: undefined as unknown as T, done: true } as IteratorResult<T>,
					hadError: true,
					error,
				};
			}
		})();
		pendingPulls.set(i, promise);
	};

	const startNextBranch = (): void => {
		const i = nextToStart++;
		const factory = factories[i];
		const fork = forks[i];
		const iter = factory(fork)[Symbol.asyncIterator]();
		iterators[i] = iter;
		branchStates[i] = 'pulling';
		activePulling++;
		schedulePull(i);
	};

	const markDone = (i: number): void => {
		if (branchStates[i] !== 'done') {
			branchStates[i] = 'done';
			activePulling--;
		}
	};

	const closeAll = async (): Promise<void> => {
		const closingPromises: Promise<unknown>[] = [];
		for (let i = 0; i < branchCount; i++) {
			const it = iterators[i];
			if (it && branchStates[i] !== 'done') {
				markDone(i);
				if (typeof it.return === 'function') {
					try {
						const p = it.return();
						closingPromises.push(Promise.resolve(p).catch(() => undefined));
					} catch {
						// Synchronous throw from return() — swallow; we are already in cleanup.
					}
				}
			}
			iterators[i] = null;
		}
		pendingPulls.clear();
		if (closingPromises.length > 0) {
			await Promise.allSettled(closingPromises);
		}
	};

	try {
		// Start the initial wave up to the concurrency cap.
		while (activePulling < concurrency && nextToStart < branchCount) {
			startNextBranch();
		}

		while (pendingPulls.size > 0) {
			const winner = await Promise.race<BranchPullResult<T> | AbortSentinel>([
				abortPromise,
				...pendingPulls.values(),
			]);
			if (winner === ABORT_SENTINEL) throw abortReason;

			const { branch, result, hadError, error } = winner;
			pendingPulls.delete(branch);

			if (hadError) {
				throw error;
			}

			if (result.done) {
				markDone(branch);
				iterators[branch] = null;
				while (activePulling < concurrency && nextToStart < branchCount) {
					startNextBranch();
				}
			} else {
				yield { branch, value: result.value };
				if (branchStates[branch] === 'pulling') {
					schedulePull(branch);
				}
			}
		}
	} finally {
		if (signal && onAbort) {
			signal.removeEventListener('abort', onAbort);
		}
		await closeAll();
	}
}

function signalReason(signal: AbortSignal): unknown {
	const reason = (signal as { reason?: unknown }).reason;
	return reason !== undefined ? reason : new Error('aborted');
}
