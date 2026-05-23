description: Review the FanOutLookupJoinNode physical node and its runtime emitter — one node per outer row that forks N parameterized child sub-plans, drives them concurrently via ParallelDriver.drive, validates atMostOne, and composes a wide row. v1 supports atMostOne-left and atMostOne-inner branch modes; manual-construction only (the recognition rule lands in 4.5).
prereq: parallel-driver-context-fork, parallel-vtab-concurrency-mode, parallel-runtime-fork-test-harness, parallel-eager-prefetch-node
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/runtime/register.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, docs/runtime.md, docs/architecture.md
----

## What landed

A new physical node and emitter that, for one outer row, fan out N parameterized child sub-plans and assemble a wide result row:

- **Plan node** (`src/planner/nodes/fanout-lookup-join-node.ts`)
  - New `PlanNodeType.FanOutLookupJoin`.
  - `FanOutBranchSpec`: `child`, `mode` ('atMostOne-left' | 'atMostOne-inner'), `outputAttrs`, `concurrencySafe`, optional `connectionKey`.
  - Constructor validates: ≥1 branch, integer concurrencyCap ≥ 1, branch `outputAttrs.length === child.getAttributes().length`, and (when present) `preserveAttributeIds.length === outer + sum(branches.outputAttrs)`.
  - Attribute layout = outer attrs + branch outputs in declared order. `atMostOne-left` branches mark their slice nullable; `atMostOne-inner` keep declared nullability.
  - `getRelations()` / `getChildren()` returns `[outer, ...branches.map(b => b.child)]`. `withChildren` rebuilds with the same branch shape and reuses `mode`/`outputAttrs`/`concurrencySafe`/`connectionKey`.
  - `computePhysical` folds left-to-right by per-branch `propagateJoinFds` with **empty equi-pair lists** (see "Honest gaps" below). Outer ordering and `monotonicOn` pass through; `estimatedRows = outer.estimatedRows`.

- **Emitter** (`src/runtime/emit/fanout-lookup-join.ts`)
  - Outer emitted via `emitPlanNode`; each branch via `emitCallFromPlan` so it surfaces as a `(ctx) => AsyncIterable<Row>` callback factory.
  - Per outer row: set the outer `RowSlot` on the parent `rctx.context` (so `ParallelDriver.fork()`'s snapshot carries the binding into every branch), build per-branch factories (wrapping non-`concurrencySafe` branches in `acquireConnectionLock(target)` keyed by `connectionKey ?? rctx.activeConnection`), fork N times, drive concurrently bounded by `concurrencyCap`, collect per-branch buffers, validate atMostOne, drop the outer row when any `atMostOne-inner` branch produced zero rows, compose, and yield.
  - atMostOne violation throws `QuereusError(StatusCode.CONSTRAINT)` with a stable message shape (`"FanOutLookupJoin: branch <i> produced more than one row for outer row (got <n>)"`).
  - Lock wrap uses `async function*` so the lock is acquired on the first pull (not at factory invocation), and released in `finally` when the inner iterator completes / throws / is `return()`-closed.
  - Registered in `runtime/register.ts`.
  - Exports `runFanOutLookupJoin` (the underlying async generator) for direct unit testing.

- **Tests** (`packages/quereus/test/runtime/fanout-lookup-join.spec.ts`)
  - 21 runtime cases + 2 strict-fork cases (gated on `QUEREUS_FORK_STRICT=1`).
  - Both helper-level (`runFanOutLookupJoin`) and plan-node-level (`FanOutLookupJoinNode` constructor, attribute layout, validatePhysicalTree, `withChildren`, `toString`).
  - Coverage shape per the ticket: atMostOne-left all-match, atMostOne-left some-empty (NULL pad), atMostOne-inner outer drop, atMostOne violation, concurrency (~50ms wall-clock for 3 branches × 50ms with `cap=3`), `concurrencyCap < N` (4 branches × 50ms with `cap=2` → ~100ms two-wave), vtab lock fan-in for serial vs reentrant-reads and distinct connections, outer-row binding propagation across iterations, consumer break after one row, strict-fork mutation-while-live (`QUEREUS_FORK_STRICT=1`), and post-completion mutation.

- **Docs**
  - `docs/runtime.md` § *FanOutLookupJoinNode (per-row fan-out lookup join)*: branch modes, lock policy, binding propagation, ordering / FD conservatism, deferred work.
  - `docs/architecture.md`: one bullet pointing at the new node and the deferred rule.

## How to test / validate

1. **Tests, normal mode** — `cd packages/quereus && yarn test --grep "FanOutLookupJoin"` (21 passing, 2 pending; full suite is `yarn test` and reports 3384 passing locally).
2. **Tests, strict-fork** — `yarn test --fork-strict --grep "FanOutLookupJoin"` (23 passing; the 2 previously-pending strict-fork cases run here; full suite under strict-fork is 3393 passing locally).
3. **Lint** — `yarn lint` (clean).
4. **Build** — `yarn build` from repo root (clean across all packages).

There are no SQL/golden-plan tests yet — those land with `4.5-parallel-fanout-lookup-join-rule`. To exercise the node manually, hand-construct a `FanOutLookupJoinNode` over a `ValuesNode` outer plus N parameterized branch sub-plans; the runtime is reachable through `emitFanOutLookupJoin` once the node is in the tree.

## Usage / shape

```ts
const node = new FanOutLookupJoinNode(
  scope,
  outerRelation,
  [
    { child: branch0, mode: 'atMostOne-left',  outputAttrs: b0Attrs, concurrencySafe: true },
    { child: branch1, mode: 'atMostOne-inner', outputAttrs: b1Attrs, concurrencySafe: false, connectionKey: sharedConn },
  ],
  /* concurrencyCap */ 4,
);
```

Per outer row, the runtime yields: `[...outerRow, ...branch0Row || nulls, ...branch1Row]` for `atMostOne-left`, dropping the outer row entirely if `atMostOne-inner` branches missed. Sibling branches sharing the same `connectionKey` against a `'serial'` module serialize through `acquireConnectionLock`; distinct connections never contend.

## Honest gaps (call out for the reviewer)

The reviewer should treat the following as deliberate v1 scope cuts, not oversights — but they are real and worth a second look:

- **FD propagation is conservative.** `computePhysical` folds the branches left-to-right with **empty equi-pair lists**. The node intentionally does not carry per-branch FK→PK alignment because it is reachable only by manual construction in this commit. When the recognition rule lands (4.5), it will attach equi-pair surfaces to `FanOutBranchSpec` and the propagation can tighten without changing the emitter. Until then, no cross-branch FDs / ECs are derived — outer-only FDs survive (LEFT) or merged-shifted FDs (INNER), nothing key-aligned.
- **No `array` / `cross` branch modes.** v1 supports `atMostOne-left` and `atMostOne-inner` only. `array` (preserve all rows per branch) and `cross` (Cartesian) modes are tracked as a follow-up backlog ticket; the node will need to grow a per-branch combinator surface and the emitter will need a materialization buffer for `cross`.
- **No optimizer rule lands here.** The node is reachable only by hand-construction or via tests. The recognition rule plus golden-plan sweep lands in `4.5-parallel-fanout-lookup-join-rule`. As a consequence, no SQL queries plan to this node yet.
- **No `expectedLatencyMs` field on `PhysicalProperties`.** The cost-gate hook for the recognition rule needs this; landing it is part of 4.5 (or a sibling ticket), not here.
- **Connection acquisition reuses `rctx.activeConnection`.** Per-branch fresh-connection acquisition (for future `'reentrant-reads'` plugins that want per-connection isolation) is deferred. v1 always shares the outer's connection unless the branch supplies an explicit `connectionKey`. Tests pass arbitrary identity objects as `connectionKey` and rely on `acquireConnectionLock`'s WeakMap-keyed semantics — the runtime cast to `VirtualTableConnection` is for the type system; the lock itself only needs object identity.
- **`validatePhysicalTree` is exercised with `{ validateAttributes: false }`.** The wide-output node deliberately re-exposes outer + branch attribute IDs, and the tree-wide uniqueness check in `plan-validator.ts` cannot distinguish pass-through from duplicate — the same limitation applies to `FilterNode` / `EagerPrefetchNode` and is not new with this commit. The test note in `fanout-lookup-join.spec.ts` is explicit about why.
- **The `atMostOne` invariant is defensive, not statically enforced.** Manual construction can produce a branch that returns >1 row; the runtime throws `QuereusError(CONSTRAINT)`. Once the recognition rule guarantees FK→PK alignment the check is unreachable in practice, but it stays as a safety net.
- **Per-iteration wrapping allocation.** `resolveBranchFactories` is invoked once per outer row to bind the lock target. For very narrow outer streams this is fine; for wide hot loops it can move into a pre-computed table-keyed map. v1 prioritises clarity over micro-optimization. Mention if the reviewer thinks this needs to move now.

## What to look at first as a reviewer

1. **Strict-fork timing.** The strict-fork test gates branch progress on a controlled `branchSignal` promise so that `driver.drive` has bumped the parent fork counter *before* the test attempts the mutation. If this reads as fragile, the alternative is to factor a "wait until forks active" hook into `ParallelDriver` and key on it — but that surfaces internal state in tests. Confirm the current timing-based approach is acceptable.
2. **Lock target fallback.** `resolveBranchFactories` falls back to `rctx.activeConnection` when no `connectionKey` is supplied; if both are absent (no connection, no hint), the branch runs raw — there is nothing to serialize on. Confirm that's the right behavior for "no connection yet" execution paths (CTE materialization, const-evaluator) vs. failing loudly.
3. **FD-propagation conservatism.** The `computePhysical` path passes `[]` for `equiPairs` and `[]` for `preservedKeys` on every branch. If `propagateJoinFds`'s key-FD layering would produce incorrect results when called this way (`withKeyFds` adds nothing if `preservedKeys === []`, which seems right), no surprises — but it's the kind of "I called the right helpers" review that a fresh pair of eyes does best.
4. **outerSlot lifecycle vs strict-fork.** The emitter installs the outer slot *before* the per-row loop and closes it in `finally`. Each fork's snapshot picks up the slot once at fork time; subsequent `outerSlot.set(row)` only mutates the ref the snapshot already points at (not the parent map). Confirm this is correct against the strict-fork contract — I believe `set(row)` on the slot does not touch `rctx.context`, so no violation; the test under strict mode passes, but a careful reader should sign off.
