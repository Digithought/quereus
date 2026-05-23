import type {
	FanOutLookupJoinNode,
	FanOutBranchMode,
} from '../../planner/nodes/fanout-lookup-join-node.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import { ParallelDriver } from '../parallel-driver.js';
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

			let dropOuter = false;
			for (let i = 0; i < branchCount; i++) {
				if (branchBuf[i].length === 0 && branchDescriptors[i].mode === 'atMostOne-inner') {
					dropOuter = true;
					break;
				}
			}
			if (dropOuter) continue;

			const composed: Row = [...outerRow];
			for (let i = 0; i < branchCount; i++) {
				const buf = branchBuf[i];
				if (buf.length === 0) {
					for (let k = 0; k < padLengths[i]; k++) composed.push(null);
				} else {
					const r = buf[0];
					for (let k = 0; k < r.length; k++) composed.push(r[k]);
				}
			}
			yield composed;
		}
	} finally {
		outerSlot.close();
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
