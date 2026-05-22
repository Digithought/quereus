description: EagerPrefetchNode — physical pass-through that forks the runtime context on emit and pumps its child sub-tree into a bounded ring buffer immediately, so the consumer's first await finds rows already in flight. Smallest end-to-end consumer of ParallelDriver (N=1, no combinator). Ships manual-construction only; the optimizer wrap-rule is a separate backlog ticket.
prereq: parallel-driver-context-fork, parallel-runtime-fork-test-harness
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/runtime/emit/eager-prefetch.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/runtime/eager-prefetch.spec.ts, docs/runtime.md
----

## Goal

A physical relational node `EagerPrefetchNode(child, bufferSize)` whose only effect is timing: when the parent emit reaches it, it forks the runtime context, starts iterating the child sub-tree immediately into a bounded ring buffer, and serves the consumer from that buffer. Rows, order, attribute IDs, keys, FDs, ECs, orderings, monotonicity all pass through verbatim.

## Architecture

### Plan node (`planner/nodes/eager-prefetch-node.ts`)

```
class EagerPrefetchNode extends PlanNode implements UnaryRelationalNode {
  readonly nodeType = PlanNodeType.EagerPrefetch
  constructor(scope, source: RelationalPlanNode, bufferSize: number = 64, estimatedCostOverride?)
  // pass-through: getAttributes(), getType(), get estimatedRows()
  getChildren(): [source]
  getRelations(): [source]
  withChildren([newSource]): new EagerPrefetchNode(...) or `this` if unchanged
  // computePhysical: not overridden — the default child-merge keeps deterministic/idempotent/readonly
  //   from the source unchanged. No new ordering/key/FD claims; no claims removed.
  toString(): `EAGER PREFETCH (buffer=${bufferSize})`
  getLogicalAttributes(): { bufferSize, sourceNodeType }
}
```

Add `EagerPrefetch = 'EagerPrefetch'` to `PlanNodeType` (the "Query execution" section next to `Cache` and `Sink` is the natural home).

Mirror the `CacheNode` shape — including `isRelationalNode(newSource)` guard in `withChildren` and the "return `this` if newSource === source" identity short-circuit.

### Emitter (`runtime/emit/eager-prefetch.ts`)

Mirrors the `emitCache` shape (`runtime/emit/cache.ts:31-64`): takes the source instruction via `emitCallFromPlan(plan.source, ctx)` and returns `{ params: [sourceInstruction], run, note }`.

The `run` function:

1. Calls `parallelDriver.fork(rctx, 1)` to obtain a single child context. (Single fork is fine; bumpParentForkCounter / dropParentForkCounter bookkeeping is handled internally by drive() today, but for the manual-pump pattern we need to bump/drop ourselves — see "Strict-fork bookkeeping" below.)
2. Calls `sourceCallback(childCtx)` to get the inner `AsyncIterable<Row>`, opens its iterator.
3. Constructs a `BoundedPrefetchBuffer<Row>(bufferSize)` (small helper, see below).
4. Starts a detached "pump" promise that loops `await childIter.next()` and pushes rows into the buffer, observing back-pressure (await space when buffer full).
5. The function itself is an async generator: it `await`s items from the buffer and yields them.
6. On consumer break / downstream throw / inner throw: cancel the pump (AbortController), best-effort `childIter.return()`, propagate the original error.

```ts
async function* run(rctx, sourceCallback): AsyncIterable<Row> {
  const [forkCtx] = driver.fork(rctx, 1)
  const parentTableState = bumpParentForkCounter(forkCtx.tableContexts)
  const parentRowState   = bumpParentForkCounter(forkCtx.context)
  const childIter = sourceCallback(forkCtx)[Symbol.asyncIterator]()
  const buf = new BoundedPrefetchBuffer<Row>(bufferSize)
  const abort = new AbortController()

  const pump = (async () => {
    try {
      while (!abort.signal.aborted) {
        const r = await childIter.next()
        if (r.done) { buf.close(); return }
        const ok = await buf.push(r.value, abort.signal)
        if (!ok) return  // aborted
      }
    } catch (e) {
      buf.fail(e)
    }
  })()
  void pump  // detach; we await it in finally

  try {
    while (true) {
      const item = await buf.shift()  // resolves with { value } | { done } | throws cached error
      if (item.done) return
      yield item.value
    }
  } finally {
    abort.abort()
    buf.close()
    try { await childIter.return?.(undefined) } catch { /* swallow */ }
    await pump.catch(() => undefined)
    dropParentForkCounter(parentTableState)
    dropParentForkCounter(parentRowState)
  }
}
```

### BoundedPrefetchBuffer<T>

Tiny internal helper colocated with the emitter (not exported from `parallel-driver.ts` — too specific). Promise-based:

```
class BoundedPrefetchBuffer<T> {
  capacity: number
  queue: T[] = []
  done: boolean = false
  error: unknown | undefined
  spaceWaiter: (() => void) | null = null   // resolved when an item is shifted out
  itemWaiter: (() => void) | null  = null   // resolved when an item is pushed in or close/fail

  async push(item: T, signal: AbortSignal): Promise<boolean>  // resolves true on push, false on abort
  async shift(): Promise<{ done: true } | { done: false; value: T }>  // throws cached error
  close(): void  // marks done; wakes any pending shift
  fail(e: unknown): void  // marks errored; wakes any pending shift to throw
}
```

The intent is bounded back-pressure: a producer that runs faster than the consumer must wait, otherwise the "bounded" promise is broken. Exactly one item-waiter and one space-waiter exist at any time (consumer is single-threaded; pump is single-threaded), so a single nullable callback suffices for each direction — no queue of waiters needed.

### Strict-fork bookkeeping

Today only `ParallelDriver.drive()` calls `bumpParentForkCounter` / `dropParentForkCounter`. Manual users of `fork()` (us) need to call these directly so strict-mode's "parent must not mutate while fork is live" check is enforced.

Two options:

- **(A)** Export `bumpParentForkCounter` / `dropParentForkCounter` from `parallel-driver.ts` (re-export from `strict-fork.ts`) and call them in the emitter.
- **(B)** Add a `ParallelDriver.driveSingle(factory, fork)` convenience that wraps the bookkeeping plus produces an `AsyncIterable<T>` for a single-branch case. Internally identical to `drive()` for N=1 but without the `{ branch, value }` wrapping.

Pick **(A)** for this ticket — simpler, no new API surface on the driver. If a second N=1 consumer appears later, refactor to (B) then.

This means importing the two helpers from `strict-fork.js` (or via a re-export added to `parallel-driver.ts`'s public surface — preferred so consumers don't reach into `strict-fork.ts`). Add the re-export.

### Emitter registration

In `runtime/register.ts`, add next to the existing Cache emitter:

```ts
registerEmitter(PlanNodeType.EagerPrefetch, emitEagerPrefetch as EmitterFunc)
```

### Out of scope (deliberately)

- **Optimizer auto-wrap rule.** A separate backlog ticket `parallel-eager-prefetch-wrap-rule` covers the rule that recognizes probe sides of physical hash joins and wraps them.
- **Tracing.** Buffer fill-rate telemetry is a follow-up tied to whatever shape the larger `InstructionRuntimeStats` pass settles on.
- **Adaptive `bufferSize`.** Static-only here.
- **Detecting redundant wrapping over `CacheNode`.** Without an auto-wrap rule, callers construct nodes manually and own this concern; the optional skip lives in the recognition rule.

## Tests (`test/runtime/eager-prefetch.spec.ts`)

Use the existing `parallel-driver.spec.ts` style as a model. Build a tiny `AsyncIterable<Row>` fixture so the tests stay below the planner-emit layer and exercise the emitter directly via `emitCallFromPlan`-style scaffolding, **or** build a minimal `RelationalPlanNode` stub and run the emitter end-to-end via the existing runtime — pick whichever matches the existing emit-unit-test pattern in `test/runtime/`.

Required cases:

- **Pass-through equivalence.** A source yielding `[A, B, C, D, E]` is observed by the consumer as exactly `[A, B, C, D, E]` in order. (Sanity.)
- **Eager start.** A source whose first `next()` resolves after a 50ms timer; the consumer's first `next()` is called after a synthetic ~30ms wait. Measure: consumer's first `next()` resolves in ≤ ~25ms of being called (because the prefetch's 50ms timer started 30ms earlier). Use wide bands as in `parallel-driver.spec.ts`.
- **Back-pressure / bounded buffer.** Track the max simultaneous "rows produced but not yet consumed". A slow consumer plus an infinite-ish fast source must hold that count ≤ `bufferSize`.
- **Consumer break.** Consumer breaks after 2 of 10 rows; assert (a) the child iterator's `return()` was called, (b) the pump terminated, (c) no unhandled rejection.
- **Inner throw.** Child throws on row 3; assert the consumer sees the error on its 3rd `next()` (or earlier — buffered rows may have already been delivered), the pump's promise is settled, and the error identity is preserved.
- **Cancellation via consumer error path.** Consumer throws while iterating; same close-all expectations as the consumer-break case.
- **Strict-fork interaction.** Wrap a tiny scenario where the parent context is mutated *after* the EagerPrefetch's emit has forked. With `QUEREUS_FORK_STRICT=1`, the parent mutation must throw the documented violation. (Mirrors the harness pattern in `1.5-parallel-runtime-fork-test-harness`.)
- **No work without consumption.** If the emitter's run function is invoked but the returned `AsyncIterable` is never iterated, the pump must not have started (because the `run` body is an async generator — its top-level code only runs on first `next()`). This is the default JS async-generator semantic; the test pins it so a future refactor doesn't accidentally make `run` eagerly start the pump.

### Pre-physical-tree validation

If `tuning.debug.validatePlan` is true (the optimizer's post-pass walker), the new node must not trip validation. Confirm by running the existing logic tests with the node manually inserted via a tiny test-only helper that wraps the right side of a known hash join plan. (If `validatePhysicalTree` rejects the unknown nodeType, add `EagerPrefetch` to whatever allow-list it consults — investigate during implementation.)

## Documentation

- `docs/runtime.md` — add a short subsection under the Parallel runtime fork contract pointing out that `EagerPrefetchNode` is the first downstream consumer of `ParallelDriver.fork()` and that callers using `fork()` manually (without `drive()`) are responsible for `bumpParentForkCounter` / `dropParentForkCounter`.
- `docs/architecture.md` — one bullet under the optimizer/runtime section noting `EagerPrefetch` as a latency-hiding pass-through. Avoid duplicating the design narrative.

## TODO

Phase 1 — Plan node
- Add `EagerPrefetch` to `PlanNodeType` (near `Cache` / `Sink`).
- Create `planner/nodes/eager-prefetch-node.ts`. Mirror `CacheNode`'s shape; pass-through type/attrs/relations/withChildren; default `computePhysical` is fine.

Phase 2 — Emitter
- Create `runtime/emit/eager-prefetch.ts` with `emitEagerPrefetch(plan, ctx): Instruction`.
- Internal `BoundedPrefetchBuffer<T>` helper colocated in the same file.
- Re-export `bumpParentForkCounter` / `dropParentForkCounter` from `parallel-driver.ts` (do not import from `strict-fork.ts` directly outside the driver).
- Wire into `runtime/register.ts`.

Phase 3 — Tests
- `test/runtime/eager-prefetch.spec.ts` covering the cases above. Reuse the wide wall-clock bands and helper patterns from `parallel-driver.spec.ts`.
- Verify with `QUEREUS_FORK_STRICT=1` for the strict-fork case.

Phase 4 — Validate
- `yarn workspace @quereus/quereus test` (full suite — confirms no regression in the in-memory vtab paths).
- `yarn workspace @quereus/quereus run lint`.
- Streaming pattern: `yarn test 2>&1 | tee /tmp/eager.log; tail -n 80 /tmp/eager.log` (per AGENTS.md).
- Do **not** run `yarn test:store` — store-specific; not relevant to this ticket.

Phase 5 — Docs
- Update `docs/runtime.md` and one bullet in `docs/architecture.md` per the Documentation section above.
