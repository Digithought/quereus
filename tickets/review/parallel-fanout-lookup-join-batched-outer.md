description: Review the batched/pipelined outer mode for `FanOutLookupJoinNode` — a global in-flight semaphore, bounded outer read-ahead with consumer-measured backpressure, per-outer-row context isolation (nested forking), and an order-preserving reorder buffer. Default stays `serial`; nothing in the optimizer constructs a batched node yet.
prereq:
files: packages/quereus/src/runtime/async-semaphore.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/runtime/async-semaphore.spec.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, docs/runtime.md, docs/optimizer.md
----

## What landed

A second execution mode for `FanOutLookupJoinNode` that overlaps lookups
*across* outer rows, not just across branches within one row.

### Phase 1 — primitives
- **`runtime/async-semaphore.ts`** — `AsyncSemaphore`: counting semaphore, FIFO
  waiter queue, single-shot idempotent `release` (double-release is a no-op),
  integer `permits >= 1` guard. On release the permit is handed directly to the
  head waiter (not returned to the pool, so a racing `acquire()` can't jump the
  queue). Exposes `availablePermits` / `waiterCount` for tests.
- **`optimizer-tuning.ts`** — two new `tuning.parallel` knobs:
  `outerBatchConcurrency` (default **16**, global in-flight budget across all
  rows) and `maxOuterReadAhead` (default **64**, hard clamp on rows admitted
  ahead of the emit frontier).

### Phase 2 — node
- `FanOutOuterMode = 'serial' | 'batched'` + `outerMode` field on
  `FanOutLookupJoinNode` (default `'serial'`). Threaded through the
  constructor (added as the **last** positional param, after
  `preserveAttributeIds`, so existing call sites are unchanged),
  `validateConstruction` (rejects unknown modes), `withChildren`, `toString`
  (`, batched` suffix), and `getLogicalAttributes` (`outerMode` key).
  `computePhysical`/`getType`/`getAttributes` deliberately untouched — ordering
  still passes through for both modes.

### Phase 3 — runtime
- Factored `composeOuterRow(outerRow, branchBuf, descriptors, padLengths) →
  Row | DROP` out of the serial loop (the NULL-pad + `atMostOne-inner` drop
  logic); serial path rewired to use it (behavior-preserving — the `>1` row
  `CONSTRAINT` check stays in the serial loop before the call).
- `runFanOutLookupJoinBatched`: single async generator with a detached outer
  pump, per-row nested fork (`rctx → rowCtx → branch forks`), per-branch task
  that acquires the global permit **before** the connection lock, a `seq`-keyed
  reorder buffer, in-order emit, and full cleanup/error/cancel. `R =
  clamp(ceil(globalCap/branchCount), 1, maxOuterReadAhead)`. Strict-fork
  counters bumped on admit / dropped on row teardown (teardown order: drop
  branch counters → close row slot → drop rctx counters).
- `emitFanOutLookupJoin` routes on `plan.outerMode`; the batched branch reads
  `ctx.db.optimizer.tuning.parallel.{outerBatchConcurrency,maxOuterReadAhead}`
  and uses a distinct note: `fanout_lookup_join_batched(N=…, globalCap=…,
  readAhead<=…)` vs `fanout_lookup_join(N=…, cap=…)`.

### Phase 4 — tests + docs
- New `test/runtime/async-semaphore.spec.ts` (6 cases: guard, immediate
  acquire, blocking, FIFO, double-release no-op, flood-cap).
- 21 batched-driver cases added to `test/runtime/fanout-lookup-join.spec.ts`
  plus node-level `outerMode` threading/rejection tests and two emitter
  routing/note assertions.
- `docs/runtime.md` § FanOutLookupJoinNode gained an "Outer execution modes"
  block; `docs/optimizer.md` tuning-knob list gained the two new knobs.

## Validation status

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus test` — **3496 passing, 0 failing, 10
  pending**. Golden-plan sweep unchanged (serial is default).
- New specs pass under both default and `QUEREUS_FORK_STRICT=1`. Fanout +
  parallel + semaphore specs pass under strict-fork (65 passing).
- `yarn workspace @quereus/quereus run lint` — clean.

## Use cases / what to exercise

- **Order preservation** under reverse completion (row 0 slowest).
- **Cross-row overlap**: M rows, `branchCount=1`, `globalCap=8` → wall-clock
  ≈ `ceil(M/8)×L` (vs serial ≈ `M×L`, contrasted in a sibling test).
- **Global budget**: `branchCount=3`, `cap=4` → readAhead would allow 6
  concurrent branch bodies, semaphore holds peak at ≤4.
- **Bounded read-ahead**: infinite outer, consume one row → pulls ≤ `cap+4`.
- **Per-row binding isolation**: many rows in flight each echo their own outer
  key (proves no shared-`ref` corruption — the headline correctness point).
- `atMostOne` `>1` → `CONSTRAINT`; `atMostOne-inner` zero-match drops; NULL-pad.
- **Shared serial connection** serializes across *different* outer rows
  (overlap counter stays ≤1).
- Branch error propagation + sibling close; early-consumer-break cleanup
  (no unhandled rejections, all per-row slots closed); empty outer; nested
  batched-over-batched budget non-multiplication; invalid-arg guards.

## Honest gaps / things the reviewer should probe

- **No end-to-end (SQL → scheduler) coverage of batched execution.** The
  recognition rule that picks batched is out of scope (`parallel-fanout-
  batched-outer-recognition` backlog), so nothing constructs a batched node
  from SQL. The emitter routing test confirms the **note** but does **not run**
  the produced instruction through the real scheduler. The batched driver is
  exercised only by directly calling `runFanOutLookupJoinBatched` with
  hand-built branch factories. The wiring between `emitCallFromPlan`-produced
  branch callables and the batched driver (param assembly, `InstructionRun`
  invocation, the eager-vs-lazy fork timing the scheduler imposes) is therefore
  **not** integration-tested. Worth a manual end-to-end smoke: construct a
  batched node over a real plan (or temporarily flip a node's mode) and run it,
  comparing rows against serial. I considered building that but it requires a
  tree-rewrite hook into the optimized `BlockNode` that felt out of scope here.
- **Timing tests use wide CI bands** and are inherently load-sensitive
  (cross-row overlap `<320ms`, serial contrast `>M×L×0.6`, budget peaks). They
  match the existing parallel-driver/eager-prefetch timing-test style but could
  flake on a heavily loaded runner.
- **`composeOuterRow` invariant split.** The serial path enforces the `>1`-row
  `CONSTRAINT` *before* calling `composeOuterRow`; the batched path enforces it
  *inside* `runBranch` (drains the branch fully, then throws with the real
  count). Both produce the same message prefix the test matches, but the
  enforcement site differs — confirm that's acceptable.
- **Cleanup drains the slow sibling.** On a branch error, global cleanup
  `return()`s live sibling iterators; an async-generator `return()` resolves
  only after the current `await` (e.g. a `sleep`) completes, so cleanup can wait
  out a slow sibling's latency. Bounded by branch latency, not unbounded, but
  note it.
- **`maxOuterReadAhead` clamp** is the only read-ahead policy — adaptive growth
  / module-reported batch size is explicitly deferred (noted in the run-function
  doc comment and the ticket).
- **Nested-budget test is synthetic** (manually nests two batched drivers); it
  asserts per-level peaks stay within each cap but isn't a real
  fan-out-over-column-store shape.

## Suggested review focus

1. **Deadlock / liveness of the scheduler** under cleanup: queued
   `semaphore.acquire()` waiters after `aborted` is set rely on running branches
   releasing permits; running branches finish naturally or via the cleanup
   `return()`. Trace the case where every permit is held by a branch being
   `return()`-closed — does it always drain?
2. **Lost-wakeup safety** of the two single-waiter signals (`emitWaiter` /
   `admitWaiter`): the predicate is re-checked before each `await waitX()`, and
   no `await` sits between the check and installing the waiter. Confirm.
3. **Strict-fork counter bookkeeping** across the nested fork: bump on admit
   (rctx via rowCtx, then rowCtx via branch forks), drop in `runRow`'s
   `finally` in the documented order. Verify no leak path on the error branch.
4. **Permit-before-lock** ordering claim (no deadlock with shared serial
   connections) — the load-bearing concurrency argument.
