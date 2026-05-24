import type {
	FanOutLookupJoinNode,
	FanOutBranchMode,
} from '../../planner/nodes/fanout-lookup-join-node.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import { ParallelDriver, bumpParentForkCounter, dropParentForkCounter } from '../parallel-driver.js';
import { AsyncSemaphore } from '../async-semaphore.js';
import { acquireConnectionLock } from '../../vtab/concurrency.js';
import type { VirtualTableConnection } from '../../vtab/connection.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/** Per-branch factory: receives a forked RuntimeContext, returns the lookup-row stream. */
export type FanOutLookupBranchFactory = (innerCtx: RuntimeContext) => AsyncIterable<Row>;

/**
 * Per-branch runtime descriptor consumed by {@link runFanOutLookupJoin}.
 * Mirrors {@link FanOutBranchSpec} but trimmed to the fields the runtime
 * actually uses — exposed for unit tests that drive the node without
 * constructing a full plan tree.
 */
export interface FanOutLookupBranchDescriptor {
	readonly mode: FanOutBranchMode;
	/** Number of output columns the branch contributes; used to size NULL padding. */
	readonly outputColCount: number;
	/** When true, branch is invoked raw; when false, the call is wrapped in a connection lock. */
	readonly concurrencySafe: boolean;
	/**
	 * Optional lock-target identity hint. The lock is keyed by object identity
	 * (see `acquireConnectionLock` — WeakMap-keyed), so any stable object will
	 * serve. When unset, the runtime falls back to `rctx.activeConnection`.
	 */
	readonly connectionKey?: object;
}

/**
 * Wrap a branch factory in a `acquireConnectionLock` critical section. The
 * lock is acquired on the first pull (since `async function*` bodies don't
 * run until `next()`) and released when the inner iterator completes,
 * throws, or is `return()`-closed.
 */
function withConnectionLock(
	factory: FanOutLookupBranchFactory,
	lockTarget: object,
): FanOutLookupBranchFactory {
	return (innerCtx: RuntimeContext) => (async function* lockedBranch() {
		const release = await acquireConnectionLock(lockTarget as VirtualTableConnection);
		try {
			for await (const row of factory(innerCtx)) {
				yield row;
			}
		} finally {
			release();
		}
	})();
}

/**
 * Resolve each branch factory to the variant the driver will invoke, applying
 * lock wrapping where the branch is not `concurrencySafe`. Branches with no
 * resolvable lock target (no `connectionKey` and no `rctx.activeConnection`)
 * pass through raw — there is nothing to serialize on, so the runtime cannot
 * enforce mutual exclusion.
 */
function resolveBranchFactories(
	rctx: RuntimeContext,
	factories: ReadonlyArray<FanOutLookupBranchFactory>,
	descriptors: ReadonlyArray<FanOutLookupBranchDescriptor>,
): FanOutLookupBranchFactory[] {
	return factories.map((factory, i) => {
		const desc = descriptors[i];
		if (desc.concurrencySafe) return factory;
		const lockTarget = desc.connectionKey ?? (rctx.activeConnection as object | undefined);
		if (!lockTarget) return factory;
		return withConnectionLock(factory, lockTarget);
	});
}

/**
 * Sentinel returned by {@link composeOuterRow} when an `atMostOne-inner` branch
 * matched zero rows: the outer row is dropped (INNER-join semantics) rather
 * than emitted.
 */
export const DROP: unique symbol = Symbol('quereus.fanout-lookup-join.drop');

/**
 * Compose one outer row plus its per-branch result buffers into a wide output
 * row, applying NULL padding for missed `atMostOne-left` branches, or signal a
 * drop when an `atMostOne-inner` branch missed.
 *
 * Each `branchBuf[i]` must already carry **at most one** row — the
 * at-most-one-per-branch invariant is the caller's responsibility (the serial
 * driver checks after `drive`; the batched driver checks per branch task).
 *
 * Shared by {@link runFanOutLookupJoin} and {@link runFanOutLookupJoinBatched}
 * so both compose identically.
 */
export function composeOuterRow(
	outerRow: Row,
	branchBuf: ReadonlyArray<ReadonlyArray<Row>>,
	branchDescriptors: ReadonlyArray<FanOutLookupBranchDescriptor>,
	padLengths: ReadonlyArray<number>,
): Row | typeof DROP {
	for (let i = 0; i < branchDescriptors.length; i++) {
		if (branchBuf[i].length === 0 && branchDescriptors[i].mode === 'atMostOne-inner') {
			return DROP;
		}
	}
	const composed: Row = [...outerRow];
	for (let i = 0; i < branchBuf.length; i++) {
		const buf = branchBuf[i];
		if (buf.length === 0) {
			for (let k = 0; k < padLengths[i]; k++) composed.push(null);
		} else {
			const r = buf[0];
			for (let k = 0; k < r.length; k++) composed.push(r[k]);
		}
	}
	return composed;
}

/**
 * Drive a fan-out lookup join for one runtime invocation: for each outer row,
 * fork N independent {@link RuntimeContext} views, invoke the N branch
 * factories concurrently via {@link ParallelDriver.drive}, collect each
 * branch's at-most-one result row, validate the `atMostOne` invariant, and
 * yield the composed wide row (or drop the outer row when any
 * `atMostOne-inner` branch returned zero rows).
 *
 * The outer row's slot is installed on `rctx.context` *before* forking so
 * that {@link ParallelDriver.fork}'s parent-snapshot semantics propagate the
 * binding into every branch's forked context.
 *
 * Exported for direct unit testing — production callers go through
 * {@link emitFanOutLookupJoin}.
 */
export async function* runFanOutLookupJoin(
	rctx: RuntimeContext,
	outerSource: AsyncIterable<Row>,
	outerRowDescriptor: number[],
	branchFactories: ReadonlyArray<FanOutLookupBranchFactory>,
	branchDescriptors: ReadonlyArray<FanOutLookupBranchDescriptor>,
	concurrencyCap: number,
	driver: ParallelDriver = new ParallelDriver(),
): AsyncIterable<Row> {
	if (branchFactories.length !== branchDescriptors.length) {
		throw new RangeError(
			`runFanOutLookupJoin: branchFactories length (${branchFactories.length}) !== branchDescriptors length (${branchDescriptors.length})`,
		);
	}
	if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
		throw new RangeError(`runFanOutLookupJoin: concurrencyCap must be a positive integer, got ${concurrencyCap}`);
	}
	const branchCount = branchFactories.length;
	const padLengths = branchDescriptors.map(b => b.outputColCount);
	const outerSlot = createRowSlot(rctx, outerRowDescriptor);
	try {
		for await (const outerRow of outerSource) {
			outerSlot.set(outerRow);
			const wrapped = resolveBranchFactories(rctx, branchFactories, branchDescriptors);
			const forks = driver.fork(rctx, branchCount);
			const branchBuf: Row[][] = Array.from({ length: branchCount }, () => []);
			for await (const { branch, value } of driver.drive(wrapped, forks, { concurrency: concurrencyCap })) {
				branchBuf[branch].push(value);
			}

			// atMostOne invariant — defensive guard for manually-constructed plans
			// or future rules that don't statically enforce FK→PK alignment.
			for (let i = 0; i < branchCount; i++) {
				if (branchBuf[i].length > 1) {
					throw new QuereusError(
						`FanOutLookupJoin: branch ${i} produced more than one row for outer row (got ${branchBuf[i].length})`,
						StatusCode.CONSTRAINT,
					);
				}
			}

			const composed = composeOuterRow(outerRow, branchBuf, branchDescriptors, padLengths);
			if (composed === DROP) continue;
			yield composed;
		}
	} finally {
		outerSlot.close();
	}
}

/** Clamp `R = ceil(globalCap / max(1, branchCount))` into `[1, maxOuterReadAhead]`. */
function deriveReadAhead(globalCap: number, branchCount: number, maxOuterReadAhead: number): number {
	const derived = Math.ceil(globalCap / Math.max(1, branchCount));
	return Math.min(Math.max(derived, 1), maxOuterReadAhead);
}

/**
 * Batched / pipelined outer driver for a fan-out lookup join: overlaps lookups
 * *across* outer rows rather than only across branches within one row.
 *
 * Shape (single async generator):
 *
 * - **Outer pump** reads `outerSource`, assigning each row a monotonically
 *   increasing `seq`, and admits at most `R` rows *ahead of the emit frontier*
 *   (the lowest not-yet-emitted seq). Admission backpressure is measured from
 *   the consumer, so a slow consumer (or a slow head-of-line row) bounds how
 *   far the outer is drained. `R = clamp(ceil(globalCap/branchCount), 1,
 *   maxOuterReadAhead)`.
 * - **Per-row context isolation (load-bearing correctness point).** Each
 *   admitted row forks its own `rowCtx` from `rctx` and installs its own
 *   {@link createRowSlot} (its own boxed `ref`). Branch forks snapshot
 *   `rowCtx`'s getter — a closure over *this row's* ref, which is never mutated
 *   again — so concurrently in-flight rows never share an outer binding. (The
 *   prior single-slot-on-parent approach is unsafe here: it mutates one shared
 *   ref per row, which would corrupt every in-flight fork.)
 * - **Global in-flight budget.** A single {@link AsyncSemaphore} over
 *   `globalCap` bounds concurrent branch lookups across *all* in-flight rows.
 *   Each branch task acquires a permit **before** taking its connection lock
 *   (the lock is taken on the wrapped factory's first pull): a lock-holder then
 *   always also holds a permit, so a permit-holder blocked on a lock waits on
 *   another permit-holder that will release — no deadlock.
 * - **Reorder buffer + in-order emit.** Completed rows land in a `seq`-keyed
 *   map; the generator yields `seq = emitFrontier` as soon as it lands,
 *   advancing the frontier (skipping DROP entries). Out-of-order completion,
 *   in-order emit — the external stream is identical to serial mode, so
 *   `computePhysical`'s ordering pass-through stays valid.
 *
 * Replay model: each admitted row re-executes its branch sub-plans against its
 * own forked context. A cached branch shared across outer rows is a correlated
 * lookup and is re-executed per row regardless.
 *
 * Exported for direct unit testing — production callers go through
 * {@link emitFanOutLookupJoin}.
 */
export async function* runFanOutLookupJoinBatched(
	rctx: RuntimeContext,
	outerSource: AsyncIterable<Row>,
	outerRowDescriptor: number[],
	branchFactories: ReadonlyArray<FanOutLookupBranchFactory>,
	branchDescriptors: ReadonlyArray<FanOutLookupBranchDescriptor>,
	globalCap: number,
	maxOuterReadAhead: number,
	driver: ParallelDriver = new ParallelDriver(),
): AsyncIterable<Row> {
	if (branchFactories.length !== branchDescriptors.length) {
		throw new RangeError(
			`runFanOutLookupJoinBatched: branchFactories length (${branchFactories.length}) !== branchDescriptors length (${branchDescriptors.length})`,
		);
	}
	if (!Number.isInteger(globalCap) || globalCap < 1) {
		throw new RangeError(`runFanOutLookupJoinBatched: globalCap must be a positive integer, got ${globalCap}`);
	}
	if (!Number.isInteger(maxOuterReadAhead) || maxOuterReadAhead < 1) {
		throw new RangeError(`runFanOutLookupJoinBatched: maxOuterReadAhead must be a positive integer, got ${maxOuterReadAhead}`);
	}

	const branchCount = branchFactories.length;
	const padLengths = branchDescriptors.map(b => b.outputColCount);
	const readAhead = deriveReadAhead(globalCap, branchCount, maxOuterReadAhead);
	const semaphore = new AsyncSemaphore(globalCap);
	// Row-independent: lock wrapping depends only on the branch descriptor and
	// the (shared) active connection, so resolve once up front.
	const wrappedFactories = resolveBranchFactories(rctx, branchFactories, branchDescriptors);

	// Completed rows awaiting in-order emit: seq -> composed Row or DROP.
	const reorder = new Map<number, Row | typeof DROP>();
	// Live branch iterators across all in-flight rows; cleanup return()s these.
	const liveIters = new Set<AsyncIterator<Row>>();
	// In-flight per-row jobs; cleanup awaits these so every row reaches teardown.
	const rowJobs = new Set<Promise<void>>();

	let nextSeq = 0;        // next seq to assign (== count admitted)
	let emitFrontier = 0;   // lowest seq not yet emitted
	let outerDone = false;  // outer source exhausted
	let aborted = false;    // teardown initiated (consumer return / error / completion)
	let firstError: unknown = undefined;

	const recordError = (e: unknown): void => {
		if (firstError === undefined) firstError = e;
		aborted = true;
		signalEmit();
		signalAdmit();
	};

	// Single-waiter signals (one emitter, one pump) — mirrors BoundedPrefetchBuffer.
	let emitWaiter: (() => void) | null = null;
	function signalEmit(): void {
		const w = emitWaiter;
		emitWaiter = null;
		if (w) w();
	}
	function waitEmit(): Promise<void> {
		return new Promise<void>(resolve => { emitWaiter = resolve; });
	}
	let admitWaiter: (() => void) | null = null;
	function signalAdmit(): void {
		const w = admitWaiter;
		admitWaiter = null;
		if (w) w();
	}
	function waitAdmit(): Promise<void> {
		return new Promise<void>(resolve => { admitWaiter = resolve; });
	}

	// Run one branch to completion against its fork, collecting <=1 row.
	// Permit-before-lock: acquire the global permit before the wrapped factory's
	// first pull (which is where the connection lock is taken).
	const runBranch = async (branchIdx: number, fork: RuntimeContext): Promise<Row[]> => {
		const release = await semaphore.acquire();
		let iter: AsyncIterator<Row> | null = null;
		try {
			if (aborted) return [];
			iter = wrappedFactories[branchIdx](fork)[Symbol.asyncIterator]();
			liveIters.add(iter);
			const rows: Row[] = [];
			while (true) {
				const r = await iter.next();
				if (r.done) break;
				rows.push(r.value);
			}
			if (rows.length > 1) {
				throw new QuereusError(
					`FanOutLookupJoin: branch ${branchIdx} produced more than one row for outer row (got ${rows.length})`,
					StatusCode.CONSTRAINT,
				);
			}
			return rows;
		} finally {
			if (iter) liveIters.delete(iter);
			release();
		}
	};

	// Drive one admitted outer row: nested fork (rctx -> rowCtx -> branch forks),
	// run all branches under the global budget, compose, and park the result in
	// the reorder buffer keyed by `seq`. Owns its full teardown in `finally`.
	const runRow = async (seq: number, outerRow: Row): Promise<void> => {
		const [rowCtx] = driver.fork(rctx, 1);
		// rowCtx is a fork of rctx: bump rctx's counters so the statement-level
		// context cannot be mutated while this row is live (strict-fork contract).
		const rctxTableState = bumpParentForkCounter(rowCtx.tableContexts);
		const rctxRowState = bumpParentForkCounter(rowCtx.context);

		// Fresh per-row slot (its own boxed ref). Set before forking branches and
		// never mutated again, so every branch fork's snapshot sees this row only.
		const rowSlot = createRowSlot(rowCtx, outerRowDescriptor);
		rowSlot.set(outerRow);

		const branchForks = driver.fork(rowCtx, branchCount);
		// branch forks are forks of rowCtx: bump rowCtx's counters for their life.
		const branchTableState = branchCount > 0 ? bumpParentForkCounter(branchForks[0].tableContexts) : null;
		const branchRowState = branchCount > 0 ? bumpParentForkCounter(branchForks[0].context) : null;

		try {
			const settled = await Promise.allSettled(
				branchForks.map((fork, i) => runBranch(i, fork)),
			);
			// Surface the first branch rejection; otherwise compose.
			let branchError: unknown = undefined;
			const branchBuf: Row[][] = new Array(branchCount);
			for (let i = 0; i < branchCount; i++) {
				const s = settled[i];
				if (s.status === 'rejected') {
					if (branchError === undefined) branchError = s.reason;
					branchBuf[i] = [];
				} else {
					branchBuf[i] = s.value;
				}
			}
			if (branchError !== undefined) {
				recordError(branchError);
				return;
			}
			if (aborted) return; // teardown in progress — result would never emit
			const composed = composeOuterRow(outerRow, branchBuf, branchDescriptors, padLengths);
			reorder.set(seq, composed);
			signalEmit();
		} catch (e) {
			recordError(e);
		} finally {
			// Teardown order respects strict-fork: drop branch counters (so
			// rowCtx.context becomes mutable) before closing the row slot, then
			// drop the rctx counters.
			dropParentForkCounter(branchRowState);
			dropParentForkCounter(branchTableState);
			rowSlot.close();
			dropParentForkCounter(rctxRowState);
			dropParentForkCounter(rctxTableState);
		}
	};

	// Outer pump: admit rows up to `readAhead` ahead of the emit frontier.
	const pump = (async () => {
		const outerIter = outerSource[Symbol.asyncIterator]();
		try {
			while (!aborted) {
				// Backpressure: block while the read-ahead window is full.
				while (!aborted && (nextSeq - emitFrontier) >= readAhead) {
					await waitAdmit();
				}
				if (aborted) break;
				const r = await outerIter.next();
				if (r.done) break;
				const seq = nextSeq++;
				const job = runRow(seq, r.value);
				rowJobs.add(job);
				void job.finally(() => rowJobs.delete(job));
			}
		} catch (e) {
			recordError(e);
		} finally {
			outerDone = true;
			signalEmit();
			try {
				await outerIter.return?.(undefined);
			} catch {
				// Swallow — already shutting down.
			}
		}
	})();
	void pump;

	let cleanedUp = false;
	const cleanup = async (): Promise<void> => {
		if (cleanedUp) return;
		cleanedUp = true;
		aborted = true;
		signalAdmit();
		signalEmit();
		// Close any still-live branch iterators so blocked branch tasks unwind
		// (their finally releases the permit, letting queued acquirers bail).
		const closings: Promise<unknown>[] = [];
		for (const it of liveIters) {
			if (typeof it.return === 'function') {
				try {
					closings.push(Promise.resolve(it.return()).catch(() => undefined));
				} catch {
					// Synchronous throw from return() — already cleaning up.
				}
			}
		}
		if (closings.length > 0) await Promise.allSettled(closings);
		// Wait for every row job to reach its teardown (drops fork counters,
		// closes row slots) and for the pump to stop.
		await Promise.allSettled([...rowJobs]);
		await pump.catch(() => undefined);
	};

	try {
		while (!(outerDone && emitFrontier >= nextSeq)) {
			if (firstError !== undefined) throw firstError;
			if (reorder.has(emitFrontier)) {
				const entry = reorder.get(emitFrontier)!;
				reorder.delete(emitFrontier);
				emitFrontier++;
				signalAdmit(); // window opened
				if (entry !== DROP) {
					yield entry;
				}
			} else {
				await waitEmit();
			}
		}
		if (firstError !== undefined) throw firstError;
	} finally {
		await cleanup();
	}
}

/**
 * Emit a {@link FanOutLookupJoinNode}.
 *
 * The outer sub-plan is emitted as a normal `AsyncIterable<Row>` source; each
 * branch is emitted as a callable so the runtime can invoke it per outer row
 * against a freshly-forked {@link RuntimeContext}.
 *
 * v1 supports only the `atMostOne-left` and `atMostOne-inner` branch modes
 * (validated at runtime via a `QuereusError(CONSTRAINT)` when a branch yields
 * more than one row). `array` / `cross` modes are deferred to a follow-up.
 */
export function emitFanOutLookupJoin(plan: FanOutLookupJoinNode, ctx: EmissionContext): Instruction {
	const outerInstruction = emitPlanNode(plan.outer, ctx);
	const branchInstructions = plan.branches.map(b => emitCallFromPlan(b.child, ctx));
	const outerRowDescriptor = buildRowDescriptor(plan.outer.getAttributes());
	const branchDescriptors: FanOutLookupBranchDescriptor[] = plan.branches.map(b => ({
		mode: b.mode,
		outputColCount: b.outputAttrs.length,
		concurrencySafe: b.concurrencySafe,
		connectionKey: b.connectionKey,
	}));
	const concurrencyCap = plan.concurrencyCap;
	const driver = new ParallelDriver();

	if (plan.outerMode === 'batched') {
		const parallel = ctx.db.optimizer.tuning.parallel;
		const globalCap = parallel.outerBatchConcurrency;
		const maxOuterReadAhead = parallel.maxOuterReadAhead;

		function runBatched(
			rctx: RuntimeContext,
			outerSource: AsyncIterable<Row>,
			...branchFactories: FanOutLookupBranchFactory[]
		): AsyncIterable<Row> {
			return runFanOutLookupJoinBatched(
				rctx,
				outerSource,
				outerRowDescriptor,
				branchFactories,
				branchDescriptors,
				globalCap,
				maxOuterReadAhead,
				driver,
			);
		}

		return {
			params: [outerInstruction, ...branchInstructions],
			run: runBatched as InstructionRun,
			note: `fanout_lookup_join_batched(N=${plan.branches.length}, globalCap=${globalCap}, readAhead<=${maxOuterReadAhead})`,
		};
	}

	function run(
		rctx: RuntimeContext,
		outerSource: AsyncIterable<Row>,
		...branchFactories: FanOutLookupBranchFactory[]
	): AsyncIterable<Row> {
		return runFanOutLookupJoin(
			rctx,
			outerSource,
			outerRowDescriptor,
			branchFactories,
			branchDescriptors,
			concurrencyCap,
			driver,
		);
	}

	return {
		params: [outerInstruction, ...branchInstructions],
		run: run as InstructionRun,
		note: `fanout_lookup_join(N=${plan.branches.length}, cap=${concurrencyCap})`,
	};
}
