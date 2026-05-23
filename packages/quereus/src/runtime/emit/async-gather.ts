import type { AsyncGatherNode } from '../../planner/nodes/async-gather-node.js';
import type { EmissionContext } from '../emission-context.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import { emitCallFromPlan } from '../emitters.js';
import { ParallelDriver } from '../parallel-driver.js';

/** Branch factory: invoked with a forked RuntimeContext, returns an async row stream. */
export type AsyncGatherFactory = (innerCtx: RuntimeContext) => AsyncIterable<Row>;

/**
 * Yield the N-ary Cartesian product of the given per-branch row buffers, in
 * lexicographic order over branch indices (branch 0 varies slowest). Caller
 * is responsible for confirming every buffer is non-empty; an empty buffer
 * means the product is empty and this helper should not be called.
 *
 * Exported for unit testing.
 */
export function* cartesianProduct(buffers: readonly Row[][]): Generator<Row> {
	const n = buffers.length;
	const indices = new Array<number>(n).fill(0);
	while (true) {
		const row: Row = [];
		for (let i = 0; i < n; i++) {
			const sub = buffers[i][indices[i]];
			for (let j = 0; j < sub.length; j++) {
				row.push(sub[j]);
			}
		}
		yield row;
		let k = n - 1;
		while (k >= 0) {
			indices[k]++;
			if (indices[k] < buffers[k].length) break;
			indices[k] = 0;
			k--;
		}
		if (k < 0) return;
	}
}

/**
 * Async-iterate the `unionAll` shape: fork N child views off `rctx`, drive
 * the factories concurrently via {@link ParallelDriver.drive}, and yield every
 * produced row in arrival order. Yielded order is non-deterministic.
 *
 * Exported for unit testing — production callers go through {@link emitAsyncGather}.
 */
export async function* runUnionAll(
	rctx: RuntimeContext,
	factories: ReadonlyArray<AsyncGatherFactory>,
	concurrencyCap: number,
	driver: ParallelDriver = new ParallelDriver(),
): AsyncIterable<Row> {
	const forks = driver.fork(rctx, factories.length);
	for await (const { value } of driver.drive(factories, forks, { concurrency: concurrencyCap })) {
		yield value;
	}
}

/**
 * Async-iterate the `crossProduct` shape: fork N child views off `rctx`,
 * drive the factories concurrently, buffer every branch's rows in memory,
 * then yield the full N-ary Cartesian product. **Every branch is drained
 * before the first row is yielded.** If any branch is empty, the product
 * is empty.
 *
 * Exported for unit testing — production callers go through {@link emitAsyncGather}.
 */
export async function* runCrossProduct(
	rctx: RuntimeContext,
	factories: ReadonlyArray<AsyncGatherFactory>,
	concurrencyCap: number,
	driver: ParallelDriver = new ParallelDriver(),
): AsyncIterable<Row> {
	const n = factories.length;
	const forks = driver.fork(rctx, n);
	const buffers: Row[][] = Array.from({ length: n }, () => []);
	for await (const { branch, value } of driver.drive(factories, forks, {
		concurrency: concurrencyCap,
	})) {
		buffers[branch].push(value);
	}
	for (let i = 0; i < n; i++) {
		if (buffers[i].length === 0) return;
	}
	yield* cartesianProduct(buffers);
}

/**
 * Emit an {@link AsyncGatherNode}.
 *
 * - `unionAll`: drives every branch concurrently and yields each branch's
 *   rows in arrival order (multiset union, no dedup). Downstream consumers
 *   requiring ordering must wrap the gather in `Sort`.
 *
 * - `crossProduct`: drives every branch concurrently, buffers each branch's
 *   rows in memory, then yields the full N-ary Cartesian product. **All
 *   branches are materialised before the first row is yielded.**
 *
 * Both combinators inherit cancellation, error propagation, strict-fork
 * bookkeeping, and consumer-break cleanup from `ParallelDriver.drive`.
 */
export function emitAsyncGather(plan: AsyncGatherNode, ctx: EmissionContext): Instruction {
	const childInstructions: Instruction[] = plan.children.map(c => emitCallFromPlan(c, ctx));
	const concurrencyCap = plan.concurrencyCap;
	const branchCount = plan.children.length;

	if (plan.combinator.kind === 'unionAll') {
		function run(
			rctx: RuntimeContext,
			...childFactories: AsyncGatherFactory[]
		): AsyncIterable<Row> {
			return runUnionAll(rctx, childFactories, concurrencyCap);
		}
		return {
			params: childInstructions,
			run: run as InstructionRun,
			note: `async_gather(unionAll, N=${branchCount}, cap=${concurrencyCap})`,
		};
	}

	function run(
		rctx: RuntimeContext,
		...childFactories: AsyncGatherFactory[]
	): AsyncIterable<Row> {
		return runCrossProduct(rctx, childFactories, concurrencyCap);
	}
	return {
		params: childInstructions,
		run: run as InstructionRun,
		note: `async_gather(crossProduct, N=${branchCount}, cap=${concurrencyCap})`,
	};
}
