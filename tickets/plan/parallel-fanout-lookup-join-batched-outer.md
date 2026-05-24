description: Add a batched / pipelined outer mode to `FanOutLookupJoinNode` (and, more generally, the per-row fan-out driver loop) so that lookups overlap *across* outer rows, not just across branches within one outer row. Today the driver processes the left side strictly one row at a time; `concurrencyCap` is a per-row cap, so the in-flight budget is under-saturated whenever per-row branch count is small. An example consumer is a column-store module where every table scan is itself a c-way positional join, making cross-row concurrency essential for vectorized (block-level) reads.
prereq: parallel-fanout-lookup-join-node
files: packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/parallel-driver.ts
----

## Problem

`runFanOutLookupJoin` (`runtime/emit/fanout-lookup-join.ts`) drives the outer side serially:

```ts
for await (const outerRow of outerSource) {       // serial over the left
  const forks = driver.fork(rctx, branchCount);
  for await (const { branch, value } of driver.drive(wrapped, forks,
                                          { concurrency: concurrencyCap })) { … }
  …compose…
  yield composed;                                 // next outer row only starts now
}
```

The N branches of a *single* outer row run concurrently, but the next outer row's lookups do not begin until the current row is fully resolved and emitted. Consequences:

- **`concurrencyCap` is a per-row budget, not a global one.** With `branchCount = 3` and `cap = 8`, only 3 lookups are ever in flight — 5 slots wasted.
- **Latency hiding is bounded to one row.** For M outer rows at round-trip latency L, wall-clock is ≈ M × L (branches overlapped within each row), not the ≈ L achievable if many rows' lookups overlapped. The node hides the *fan*, not the *scan*.
- **`EagerPrefetchNode` on the outer does not fix this.** Prefetching outer rows fills a buffer, but this loop still consumes them one at a time and blocks on each row's branches. The serialization point is the loop itself, not outer-row availability.

This is the classic **batched / pipelined (asynchronous) index nested-loop join** — SQL Server "batch mode," Oracle "batched nested loops," vectorized lookup. It is the right shape when there are many outer rows but few branches per row, which is the common case.

## Example use case — column-store module

A column-store vtab module stores each table as `c` independent column segments. Reading a logical row is a **c-way positional join** across those segments (aligned by row key / ordinal). So:

- A base scan of such a table is internally a `zipByKey`-shaped c-way gather (see `parallel-async-gather-zip-by-key`), and an *index lookup* into it is a c-way keyed gather per probe.
- Columnar storage only pays off when reads are **vectorized**: fetch a block of many rows' worth of a column segment per I/O. Resolving one logical row at a time across `c` segments is the pathological access pattern columnar storage exists to avoid.
- Therefore the in-flight budget must be saturated **across outer rows**: keep `≈ R × c` segment reads in flight (R = outer read-ahead depth), not `c`.

When a fan-out lookup join probes such a module, both levels compound: the outer may itself be a column-store scan, and each branch is a c-way segment gather. Cross-row batching at the fan-out level is what lets the module batch segment reads into block I/O.

## Requirements

- **Global in-flight budget across outer rows.** Redefine (or supplement) `concurrencyCap` so the cap bounds total concurrent branch lookups across all in-flight outer rows, not lookups within a single outer row. A small per-row branch count must still be able to saturate the budget by admitting more outer rows.
- **Bounded outer read-ahead with backpressure.** Read at most R outer rows ahead (R derived from the budget and branch count). Do not drain an unbounded outer into memory — mirror `EagerPrefetchNode`'s bounded-ring discipline.
- **Order-preserving output.** The node yields composed rows in outer order today; the batched form must preserve that. Outer rows complete out of order under concurrency, so a reorder/completion buffer is required (in-order emit over out-of-order completion — the same problem `EagerPrefetchNode` solves for a single stream, here keyed per outer row).
- **Concurrency-contract handling at the wider scope.** `concurrencySafe` / `acquireConnectionLock` currently serialize within one outer row's branches. With multiple outer rows in flight, the same connection may now be contended by branches of *different* outer rows — the lock accounting must cover the wider in-flight set, not just sibling branches of one row.
- **Compose with reset/cache replay.** The replay model (re-execution primary, `CacheNode` optional — see `parallel-fanout-lookup-join-cross-mode`) must continue to hold per outer row; a cached branch shared across outer rows is a correlated lookup and is re-executed per row regardless.

## Out of scope

- Adaptive scheduling (issue slowest branch/row first). Same cut as `unionAll` / `crossProduct` v1.
- The recognition/cost-model changes that decide *when* to pick batched vs. serial outer. File separately once the runtime mode exists; the cost signal is the same `expectedLatencyMs` surface plus outer cardinality.
- Streaming `cross` interaction (1:n branches under a batched outer multiply the in-flight accounting). Note the interaction; defer the combined mode.

## Open questions

- **Budget shape.** Single global semaphore over all in-flight lookups, vs. a two-level cap (max outer rows in flight × max branches per row)? The column-store case wants the former (saturate block I/O regardless of per-row shape); document the choice and make the knob explicit in `tuning.parallel`.
- **Read-ahead depth derivation.** Fixed R, or `R = ceil(budget / branchCount)`, or adaptively grown? Start with the derived form; revisit if a module reports a preferred batch size.
- **Hierarchical budgets under nesting.** When the outer is itself a fan-out/zip over a column store, in-flight accounting is hierarchical. `ParallelDriver` already supports nested forks via per-context fork counters (per the `parallel-fanout-lookup-join-node` review); confirm the global budget composes sanely across nesting levels rather than multiplying without bound.

## End
