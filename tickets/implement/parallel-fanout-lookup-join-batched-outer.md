description: Add a batched / pipelined outer mode to `FanOutLookupJoinNode` so lookups overlap *across* outer rows, not just across branches within one outer row. Introduces a global in-flight budget (shared across all in-flight outer rows), bounded outer read-ahead with backpressure, and an order-preserving reorder buffer. The recognition/cost decision of *when* to pick batched stays out of scope (see `parallel-fanout-batched-outer-recognition` backlog).
prereq: parallel-fanout-lookup-join-node
files: packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/runtime/emit/eager-prefetch.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts
----

## Problem

`runFanOutLookupJoin` (`runtime/emit/fanout-lookup-join.ts:98`) drives the outer
side strictly serially: it forks `branchCount` contexts for one outer row,
drives them concurrently via `ParallelDriver.drive(..., { concurrency: cap })`,
composes, yields, and only then reads the next outer row. The N branches of a
*single* row overlap; the next row's lookups do not begin until the current row
is fully resolved and emitted.

Consequences:

- **`concurrencyCap` is a per-row budget, not a global one.** With
  `branchCount = 3` and `cap = 8`, only 3 lookups are ever in flight — 5 slots
  wasted. A small per-row branch count can never saturate the budget.
- **Latency hiding is bounded to one row.** For M outer rows at round-trip
  latency L, wall-clock is ≈ M × L, not the ≈ L achievable if many rows'
  lookups overlapped.
- **`EagerPrefetchNode` on the outer does not fix this.** Prefetching fills the
  outer buffer, but this loop still consumes one row at a time and blocks on
  each row's branches. The serialization point is the loop itself.

This is the classic **batched / pipelined index nested-loop join** (SQL Server
batch mode, Oracle batched nested loops). It is the right shape when there are
many outer rows but few branches per row — the common case, and the
load-bearing case for a column-store vtab whose base scan is itself a c-way
positional gather that only pays off when reads are vectorized across many rows.

## Design

### Two execution modes on one node

`FanOutLookupJoinNode` gains an `outerMode: FanOutOuterMode` field where
`type FanOutOuterMode = 'serial' | 'batched'`. **Default `'serial'`** so existing
plans and the optimizer golden-plan sweep are byte-for-byte unchanged; nothing
yet *constructs* a batched node (the recognition rule is a separate backlog
ticket). The field threads through the constructor, `validateConstruction`,
`withChildren`, `toString`, and `getLogicalAttributes`. Physical-property /
FD propagation is mode-independent (ordering still passes through — see below),
so `computePhysical`/`getType`/`getAttributes` are untouched.

The emitter (`emitFanOutLookupJoin`) selects the run function on
`plan.outerMode`: `'serial'` → existing `runFanOutLookupJoin` (unchanged);
`'batched'` → new `runFanOutLookupJoinBatched`. Both share
`resolveBranchFactories` / `withConnectionLock` / the `atMostOne` and
NULL-padding / drop logic — factor the per-row "compose ≤1-row-per-branch into a
wide row, or signal drop" step into a shared helper
`composeOuterRow(outerRow, branchBuf, branchDescriptors, padLengths)` returning
`Row | DROP` so both drivers call it identically.

### Global in-flight budget (single semaphore)

**Resolved open question — budget shape:** use a **single global semaphore**
over all in-flight branch lookups, not a two-level (rows × branches) cap. The
column-store case wants to saturate block I/O regardless of per-row shape, and
a single budget lets a small `branchCount` saturate by admitting more outer
rows. Make the knob explicit:

`tuning.parallel` gains:
- `outerBatchConcurrency: number` (default 16) — the global cap: max concurrent
  branch lookups across *all* in-flight outer rows in a batched node. This is
  distinct from `concurrency` (the existing per-row serial cap, default 8),
  which continues to govern serial-mode nodes.
- `maxOuterReadAhead: number` (default 64) — hard clamp on the number of outer
  rows admitted ahead of the emit frontier, so `branchCount = 1` cannot fork an
  unbounded number of contexts.

**Read-ahead derivation (resolved open question):** start with the derived form
`R = clamp(ceil(globalCap / max(1, branchCount)), 1, maxOuterReadAhead)`. Revisit
adaptive growth only if a module reports a preferred batch size (note it; do not
build it).

Add a tiny `AsyncSemaphore` primitive (new file
`runtime/async-semaphore.ts`, or co-located in `parallel-driver.ts` next to the
fork helpers — implementer's call, prefer a standalone file for testability):

```ts
class AsyncSemaphore {
  constructor(permits: number);           // permits >= 1, integer
  acquire(): Promise<() => void>;          // resolves with a single-shot release
  // FIFO waiter queue; release() hands the permit to the head waiter or
  // returns it to the pool. Double-release is a no-op (guard with a flag).
}
```

This mirrors the waiter discipline already in `BoundedPrefetchBuffer`
(`eager-prefetch.ts:17`) but as a counting semaphore rather than a 1-slot
buffer.

### Per-outer-row context isolation — the load-bearing correctness point

**The current single-slot-on-parent approach cannot support multiple outer rows
in flight.** `createRowSlot` (`context-helpers.ts`) installs a getter that closes
over a *shared boxed `ref`*; `ParallelDriver.fork` snapshots the parent context
by copying that getter *by reference*. Today the loop does `outerSlot.set(row)`
then forks, and because rows are processed serially the `ref` mutation for row
N+1 happens only after row N's forks are fully drained. Under cross-row
concurrency, mutating one shared `ref` would corrupt every in-flight fork's
binding.

Therefore the batched driver must give **each in-flight outer row its own slot
(its own `ref`)**. Recommended shape, per admitted outer row:

1. `const [rowCtx] = driver.fork(rctx, 1)` — a per-row context.
2. `const rowSlot = createRowSlot(rowCtx, outerRowDescriptor); rowSlot.set(outerRow)`
   — fresh `ref`, isolated to this row.
3. `const forks = driver.fork(rowCtx, branchCount)` — each branch fork snapshots
   `rowCtx`'s getter (closure over the per-row `ref`, which is never mutated
   again), so all branches of this row see this row's binding and no other's.

This is nested forking (rctx → rowCtx → branch forks). `ParallelDriver` already
supports nested forks via per-context fork counters (confirmed by the
`parallel-fanout-lookup-join-node` review). When driving branches *without*
`ParallelDriver.drive` (see scheduling below), bump/drop the strict-fork
counters manually on `rowCtx` exactly as `prefetchAsyncIterable`
(`eager-prefetch.ts:139,177`) does — bump on admit, drop on row completion.
Close `rowSlot` when the row's branches all finish.

### Scheduling — standalone batched scheduler

`ParallelDriver.drive`'s `concurrency` is per-call, so it cannot express a budget
shared across multiple rows' drives. Build the batched scheduler directly in
`fanout-lookup-join.ts` using `driver.fork` + the shared `AsyncSemaphore`, rather
than threading a semaphore through `drive` (keeps `drive` untouched; the
at-most-one-row-per-branch contract makes the per-branch logic simpler than
`drive`'s general case anyway).

Structure (one async generator, `runFanOutLookupJoinBatched`):

- **Outer pump** reads `outerSource` and admits rows, assigning each a
  monotonically increasing `seq`. Admission is gated so that at most `R` rows
  are in flight *ahead of the emit frontier* (the lowest not-yet-emitted `seq`),
  giving backpressure measured from the consumer, not from raw rows read. Do not
  drain the outer unboundedly.
- **Per-row job**: fork as above; launch each branch as a task that
  `await semaphore.acquire()` → run the (already lock-wrapped where needed)
  branch factory to completion collecting ≤1 row → enforce `atMostOne` → release
  permit. **Permit-before-lock ordering is required** (acquire the global permit
  before the branch's `withConnectionLock` lock, which is taken on first pull):
  a connection-lock holder then always also holds a global permit, so a
  permit-holder blocked on a lock is always waiting on another permit-holder that
  will release — no deadlock. (See concurrency-contract note below.)
- **Completion → reorder buffer**: when all branches of a row finish, call
  `composeOuterRow`; store `{ seq, result | DROP }` in a reorder map keyed by
  `seq`. Drop strict-fork counters and close the row slot here.
- **Order-preserving emit**: the generator yields composed rows in `seq` order —
  it emits `seq = emitFrontier` as soon as that row's result lands, advancing the
  frontier (skipping DROP entries). Out-of-order completion + in-order emit is the
  same problem `EagerPrefetchNode` solves for one stream, here keyed per outer
  row. A slow row 0 holds back rows 1..R (bounded), whose permits are released as
  they complete so new rows admit up to R ahead of the frontier.
- **Cleanup / error / cancel**: on consumer `return()`, downstream `throw`, or any
  branch error, abort the pump, `return()` all live branch iterators (best-effort,
  `Promise.allSettled`), release outstanding permits, drop all bumped fork
  counters, and close all open row slots. Re-raise the first branch error after
  closing. Mirror `driveImpl`'s `closeAll` discipline (`parallel-driver.ts:221`)
  and `prefetchAsyncIterable`'s `cleanup` (`eager-prefetch.ts:166`).

### Order preservation

The serial node yields in outer order today and the optimizer may rely on
`outerPhys.ordering` passing through (`computePhysical` copies it). The batched
form **must** preserve that exact output order via the reorder buffer above — so
`computePhysical` keeps propagating `outerPhys.ordering` for both modes
unchanged. (Internally rows complete out of order; externally the stream is
identical to serial mode.)

### Concurrency-contract handling at the wider scope

`acquireConnectionLock` (`vtab/concurrency.ts:40`) is keyed by connection
identity in a **module-global WeakMap with a single promise chain** — it already
serializes across *all* callers of a connection regardless of outer row. So
there is **no per-row lock scope to widen**; `withConnectionLock`
(`fanout-lookup-join.ts:46`) composes correctly with the batched path as-is. The
only new consideration is the permit-before-lock ordering above (deadlock
avoidance) and that more rows in flight raise contention on a shared serial
connection — which is correct, just throughput-bounded by that connection. Add a
test asserting a shared `'serial'` connection across branches of *different*
outer rows still serializes (no overlap) under the batched driver.

### Compose with reset/cache replay

The replay model (re-execution primary, `CacheNode` optional — see
`parallel-fanout-lookup-join-cross-mode`) holds per outer row unchanged: each
admitted row re-executes its branch sub-plans against its own forked context. A
cached branch shared across outer rows is a correlated lookup and is
re-executed per row regardless. No change needed beyond the per-row fork
isolation above; note it in the run-function doc comment.

## Out of scope (file/defer, do not build here)

- **Recognition / cost model deciding when to pick batched vs serial** — backlog
  ticket `parallel-fanout-batched-outer-recognition` (created alongside this).
  The cost signal is the same `expectedLatencyMs` surface plus outer cardinality.
  Until that lands, batched mode is reachable only by directly constructing the
  node with `outerMode: 'batched'` (tests do this).
- **Adaptive read-ahead growth / module-reported batch size** — note the hook,
  start with the derived `R`.
- **Streaming `cross` interaction** (1:n branches under a batched outer multiply
  the in-flight accounting) — defer the combined mode; note the interaction in
  the cross-mode ticket reference.
- **Hierarchical budgets when the outer is itself a fan-out/zip over a column
  store.** Per-context fork counters already compose; confirm with one nested
  test (below) that the global budget does not multiply without bound across
  nesting levels, but do not build a cross-level shared budget here.

## Key tests (extend `test/runtime/fanout-lookup-join.spec.ts`)

Drive `runFanOutLookupJoinBatched` directly (the existing spec already builds
contexts, array outers, and branch factories without a full plan tree).

- **Order preservation under out-of-order completion.** Outer rows `[[0],[1],[2]]`;
  branch factory sleeps `30 - seq*10` ms (row 0 slowest). Assert output is in
  outer order `[[0,...],[1,...],[2,...]]` despite reverse completion.
- **Cross-row overlap (the whole point).** Many outer rows, `branchCount = 1`,
  each branch sleeps L ms, `outerBatchConcurrency = 8`. Assert wall-clock ≈
  `ceil(M/8) × L`, not `M × L` (loose band like the existing
  `parallel-driver.spec.ts` timing tests at `:225`). Contrast: serial mode on the
  same input ≈ `M × L`.
- **Global budget is respected.** Instrument a shared counter incremented on
  branch entry / decremented on exit; assert peak concurrent branches ≤
  `outerBatchConcurrency` across the whole run (not per row).
- **Bounded read-ahead / backpressure.** Infinite-ish outer; consume only the
  first few rows then `return()`; assert the number of outer rows pulled is ≤
  `R + smallSlack` (mirror `eager-prefetch.spec.ts:161` "producer pauses").
- **Per-row binding isolation.** Branch factory reads the outer binding via
  `resolveAttribute` and echoes it; with many rows concurrently in flight assert
  each composed row carries *its own* outer key (proves no shared-`ref`
  corruption).
- **`atMostOne` violation still throws** `QuereusError(CONSTRAINT)` and
  **`atMostOne-inner` zero-match drops** the outer row — same assertions as serial,
  run through the batched driver.
- **Shared serial connection serializes across rows.** Two branches on the same
  `concurrencySafe: false` connection key, multiple outer rows; assert no two
  lock-wrapped branch bodies overlap (overlap counter stays ≤ 1).
- **Error propagation + cleanup.** A branch throws mid-run; assert the original
  error surfaces, all other branch iterators are `return()`-closed, and (under
  `QUEREUS_FORK_STRICT=1`) no fork-counter leak.
- **Cancellation.** Consumer breaks out early; assert pump stops, branches close,
  counters drop.
- **Nested batched-over-batched (hierarchical budget).** A batched node whose
  outer is itself a batched node; assert it completes correctly and peak global
  concurrency at each level stays within that level's cap (does not multiply
  without bound). Strict-fork mode on.

Also add an emitter-level assertion (lighter, in the optimizer/plan tests or a
unit on `emitFanOutLookupJoin`) that `outerMode: 'serial'` still routes to the
unchanged serial path (default), and `'batched'` routes to the batched run
function — `note` string distinguishes them (`fanout_lookup_join_batched(...)`).

## TODO

### Phase 1 — primitives
- [ ] Add `AsyncSemaphore` (`runtime/async-semaphore.ts`): counting semaphore,
  FIFO waiters, single-shot idempotent `release`, integer `permits >= 1` guard.
  Export for unit tests; add a focused spec (acquire/release ordering, FIFO,
  over-release no-op, concurrent acquirers).
- [ ] Add `tuning.parallel.outerBatchConcurrency` (default 16) and
  `maxOuterReadAhead` (default 64) to `OptimizerTuning` + `DEFAULT_TUNING`
  (`optimizer-tuning.ts`), with doc comments matching the style of the existing
  `concurrency` / `prefetchBufferSize` entries.

### Phase 2 — node
- [ ] Add `FanOutOuterMode` type and `outerMode` field to `FanOutLookupJoinNode`
  (default `'serial'`); thread through constructor, `validateConstruction`
  (reject unknown modes), `withChildren`, `toString`, `getLogicalAttributes`.
  Leave `computePhysical`/`getType`/`getAttributes` unchanged (ordering still
  passes through). Verify the optimizer golden-plan sweep is unchanged.

### Phase 3 — runtime
- [ ] Factor `composeOuterRow(outerRow, branchBuf, descriptors, padLengths)`
  (returns `Row | typeof DROP`) out of the serial loop; rewire serial path to use
  it (behavior-preserving).
- [ ] Implement `runFanOutLookupJoinBatched` (outer pump + per-row nested fork +
  per-branch global-permit task + reorder buffer + in-order emit + full
  cleanup/error/cancel). Derive `R = clamp(ceil(globalCap/branchCount), 1,
  maxOuterReadAhead)`. Document permit-before-lock ordering and per-row slot
  isolation in the doc comment.
- [ ] Route `emitFanOutLookupJoin` on `plan.outerMode`; pass
  `outerBatchConcurrency` / `maxOuterReadAhead` from `ctx`/tuning into the batched
  run; give batched a distinct `note`.

### Phase 4 — tests + validation
- [ ] Add the runtime tests above to `fanout-lookup-join.spec.ts` and the
  `AsyncSemaphore` spec. Run both default and `QUEREUS_FORK_STRICT=1`.
- [ ] `yarn workspace @quereus/quereus run build`, then
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/fanout-test.log; tail -n 80 /tmp/fanout-test.log`,
  then `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- [ ] Update `docs/runtime.md` (and `docs/optimizer.md` if it documents the
  fan-out node) with the batched outer mode, the global-budget semantics, and the
  two new tuning knobs.
