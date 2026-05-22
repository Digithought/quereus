description: Review the new ParallelDriver runtime primitive and its RuntimeContext fork semantics. This is the risk-discovery review for the whole `parallel-*` track — the Riskiness Assessment below is the headline deliverable for the next plan pass.
files: packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/runtime/parallel-driver.spec.ts, docs/runtime.md, docs/architecture.md
----

## Summary of changes

Adds `ParallelDriver` as a standalone runtime helper. It has two operations:

- `fork(rctx, n)` — returns `n` independent `RuntimeContext` views. Each fork gets a fresh `RowContextMap` seeded by replaying the parent's entries via the public `set()` (so the per-attribute index stays consistent) and a fresh `tableContexts` Map seeded by `new Map(parent.tableContexts)`. Shared by reference: `db`, `stmt`, `params`, `enableMetrics`, `tracer`, `activeConnection`, `contextTracker`, `planStack`.
- `drive(factories, forks, opts?)` — async generator that races N `(ctx) => AsyncIterable<T>` factories with a bounded concurrency cap and `AbortSignal` cancellation, yielding `{ branch, value }` pairs in arrival order. On any branch throw or signal abort, every other in-flight iterator is best-effort `return()`-closed before the error propagates. The same close-all path runs when the consumer breaks out of the `for-await` early.

The driver is intentionally combinator-agnostic — no zip, merge, or per-branch fan-in. Downstream nodes (`FanOutLookupJoin`, `AsyncGatherNode`, `EagerPrefetchNode`) will impose their own combinators on top.

### Files actually modified

- `packages/quereus/src/runtime/parallel-driver.ts` (new — 215 lines including doc comments)
- `packages/quereus/test/runtime/parallel-driver.spec.ts` (new — 11 tests, ~260 lines)
- `docs/runtime.md` (new subsection between the optimizer-integration section and the incremental-delta section)
- `docs/architecture.md` (one bullet appended to *Recent refinements*)

**No existing emitter, planner, optimizer, scheduler, or context helper was touched.** This is intentional and is itself the headline finding (see Riskiness Assessment).

## How to validate

### Unit tests

```
cd packages/quereus && yarn test:all --grep ParallelDriver
```

The spec file covers, in this order:

1. `fork()` — n independent contexts, read-only field sharing, sibling write isolation via `createRowSlot`, parent `context.size` immutability across a fork lifecycle, RangeError on negative / non-integer n, n=0 returns `[]`.
2. `drive()` concurrency — unbounded default (four 50ms-delayed factories complete in well under 150ms wall-clock), and concurrency-cap (concurrency=2 over four 50ms factories lands inside the 75–175ms band, demonstrating two waves rather than one or four).
3. `drive()` cancellation — branch-1-throws-at-row-2 cancels and `return()`-closes branches 0/2/3 and re-throws the original error; consumer-break-early `return()`-closes every active branch; pre-aborted signal rejects without invoking any factory.

### Full suite

`yarn test` from the repo root passes (`3307 passing` in the quereus workspace, plus all sibling-package suites). `yarn workspace @quereus/quereus run lint` is clean (exit 0).

### Use cases worth probing

The primitive has no SQL surface yet, so there are no sqllogic tests. Reviewers should focus on:

- **`fork()` semantics under non-trivial parent contexts.** The current tests only exercise an empty parent `RowContextMap` and an empty `tableContexts`. A reviewer-added test that seeds the parent with one or more pre-existing slots (simulating an outer-loop context, à la nested-loop join) and verifies that a forked branch can resolve those attributes via `resolveAttribute` would strengthen the contract.
- **Concurrency-cap fidelity under load.** The 75–175ms band is wide and survives CI noise locally, but on a contended CI runner the 50ms tick may stretch enough to bleed past 175ms. Worth a try in CI before downstream tickets bake in tighter timing assumptions.
- **`return()` propagation through layered async generators.** The mock source's `try/finally` proves the *outer* `return()` lands. A reviewer-added factory that wraps another async generator (i.e. has its own `try/finally`) would verify that the close-all walks the full chain.
- **Multiple rows per branch.** The current concurrency tests use 1-row factories. The cancel-on-error test uses 5-row factories with throw-at-row-2. There is no test that streams many rows per branch and verifies fairness (e.g. that no single branch monopolizes the yield order beyond the concurrency cap permits). Worth a probe if the next consumer is sensitive to interleaving.

## Riskiness Assessment

This is the headline output of the review pass. The remaining `parallel-*` tickets (`parallel-eager-prefetch-node`, `parallel-vtab-concurrency-mode`, `parallel-fanout-lookup-join`, `parallel-async-gather-node`) all assume the primitive landed cleanly. Below is the implementation agent's honest assessment.

### Context-fork shape — **green**

The wrapper-via-overlay approach landed without touching any existing file. Implementation:

```ts
const childContext = new RowContextMap();
for (const [desc, getter] of rctx.context.entries()) {
  childContext.set(desc, getter);
}
```

Re-driving the parent's entries through the public `RowContextMap.set()` API automatically rebuilds the `attributeIndex` for the fork — no need to subclass, copy private fields, or change the public surface of `RowContextMap`. Subsequent fork-local `set()` / `delete()` calls update only the fork's index, leaving parent's untouched.

**Files modified beyond `runtime/parallel-driver.ts` and the new test file: zero.** No emitter changes. No `context-helpers.ts` changes. No scheduler changes. The "small surgical refactor" escape hatch in the ticket spec was not needed.

### Surprises in `tableContexts` — **yellow (one named caveat)**

Yes — `packages/quereus/src/runtime/emit/recursive-cte.ts:106-129` does mutate `rctx.tableContexts` per iteration with the canonical `set(tableDescriptor, fn); try { ... } finally { delete(tableDescriptor); }` pattern. Internal recursive CTE refs read from `rctx.tableContexts` in `runtime/emit/internal-recursive-cte-ref.ts:17-23`.

The fork's `new Map(parent.tableContexts)` snapshot handles the *fork-mutates-its-own-table-context* direction cleanly. The remaining caveat is the *parent-mutates-after-fork* direction: if a recursive CTE outside the parallel boundary updates its working table *during* a fork's execution, the fork sees the value captured at fork time, not the updated one.

For the obvious composition orders this is fine:

- **Parallel-inside-recursive**: parent's iteration sets the working table, then runs the recursive-case callback (which contains the parallel boundary), then the iteration's `finally` deletes the entry. The fork sees the working-table that was current when it was forked — correct.
- **Recursive-inside-parallel**: each branch runs its own recursive CTE on its own forked `tableContexts`, so set/delete is fork-local. Correct.

The case that *would* break: a parallel boundary whose lifetime spans multiple iterations of an outer recursive CTE that mutates the same working-table descriptor. That is not a pattern any downstream ticket proposes, but it's worth flagging because the overlay semantic is snapshot-at-fork, not read-through. If a later consumer needs read-through (parent mutations visible to active forks), that is a one-line change: store a reference to `parent.tableContexts` and walk it on `.get` miss. Defer until a consumer actually needs it.

### `activeConnection` reentrancy — **deferred per scope**

The fork inherits `activeConnection` by reference. The ticket spec explicitly defers concurrency-safety of `activeConnection` to a separate `parallel-vtab-concurrency-mode` ticket and says "this ticket assumes serialized vtab access and the only consumers are unit-test mock factories." That assumption holds: the new test file uses pure async generators that touch no vtab.

A grep for `rctx.activeConnection` shows only consumer sites that *read* it for vtab access (insert / update emitters, deferred constraint queue, sequencing); none of those participate in parallel paths today. The primitive's contract — share `activeConnection`, declare nothing about concurrency safety — is the right shape for the upcoming concurrency-mode ticket to layer on top.

No surprises in `activeConnection` beyond the obvious read sites.

### Test wall-clock fidelity — **green-but-loose**

Local run on Windows + Node 20 + mocha/ts-node + the standard project test runner:

- Parallel-by-default (four 50ms factories, expect < 150ms): **53ms**.
- Concurrency cap (four 50ms factories, concurrency=2, expect 75–175ms): **124ms**.

Both inside their bands with comfortable margin. The bands are deliberately ~3× the nominal tick to absorb CI jitter. No tolerance band wider than 2× was needed — but the bands *are* wider than 2× as a defensive choice, which the spec's "wide band → yellow flag for benchmark work" comment anticipates. Reading: **timing-based regression detection in this file will not be useful**. Downstream benchmark work for `parallel-*` should use dedicated micro-benchmarks (e.g. in `bench/`), not these unit tests.

### Go / no-go recommendation — **green**

Proceed with the remaining `parallel-*` tickets as designed. Specifically:

- **`2-parallel-eager-prefetch-node`** — green. Single-branch prefetch is a simpler shape than what the driver already supports.
- **`3-parallel-vtab-concurrency-mode`** — green. The vtab-side concurrency declaration is orthogonal to the driver; the driver's "share `activeConnection`" choice is the right shape to layer the declaration on top of.
- **`4-parallel-fanout-lookup-join`** — green, with the named caveat above: if the lookup-join wants to fork *inside* an outer recursive CTE that is still iterating its working table, it would need overlay-with-read-through semantics on `tableContexts`. None of the current join-shape proposals require this, but worth confirming when the lookup-join ticket is planned.
- **`5-parallel-async-gather-node`** — green. AsyncGather is a pure combinator over driver output.

No tickets need to move back to `backlog/`. No scope reductions necessary.

## Review findings

(Reserved for code-quality issues surfaced by the reviewer — none flagged by the implementation agent. The Riskiness Assessment above is the headline output; this section is for anything else the reviewer wants to call out in the standard format.)
