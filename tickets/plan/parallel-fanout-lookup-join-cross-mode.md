description: Extend `FanOutLookupJoinNode` (v1 lands `atMostOne` only) with a `cross` per-branch mode for 1:n lookups. A `cross` branch contributes the full Cartesian product per outer row — the same result as the chain of nested-loop joins it replaces — while keeping the concurrent fan-out drive. Replay of re-traversed branches is delegated to a composed `CacheNode`, not buffered inside the node.
prereq: parallel-fanout-lookup-join-node, parallel-fanout-lookup-join-rule
files: packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/nodes/cache-node.ts
----

## Scope

Add `cross` to `FanOutBranchMode`. Where v1 parallelizes only provable at-most-one (FK→PK) lookups — 1:1 enrichment — `cross` extends the *same* concurrent fan-out to 1:n branches whose cardinality is data-driven:

- A `cross` branch contributes the full Cartesian product per outer row. The node emits one row per `(outer, b0_row, b1_row, …)` tuple, matching the nested-loop join chain it replaces.
- FDs are the product of per-branch FDs as in today's `JoinNode` — the existing `propagateJoinFds` left-to-right fold, with `inner` join type per `cross` branch.

### Replay is re-execution first, caching second

A Cartesian product must re-traverse all but the outermost branch, and branch cursors are single-pass `AsyncIterable<Row>`. The **foundational** replay mechanism is *re-execution* ("reset"): a branch child is emitted as a factory (`emitCallFromPlan` → `(ctx) => AsyncIterable<Row>`), and calling it again produces a fresh stream with **O(1) memory regardless of set size**, re-paying the branch's compute. This is exactly how the nested-loop join re-iterates its inner side (`runtime/emit/join.ts:40,67` — `rightCallback(rctx)` per outer row; the contract comment at `join.ts:39` is *"rightSource must be re-startable (optimizer facilitates through cache node)"*). The fan-out node holds **no ad-hoc buffer of its own** — mirroring how `EagerPrefetchNode` owns its ring buffer rather than its consumers.

`CacheNode` (`planner/nodes/cache-node.ts`) is an **optional accelerator** layered on re-execution, inserted by the optimizer when re-running a branch is costlier than holding its rows. It **self-limits**: `streamWithCache` (`runtime/cache/shared-cache.ts`) caches up to `threshold`, then on overflow dumps the partial cache and reverts to pass-through — i.e. back to re-execution. So a really large branch set never causes unbounded memory; correctness is always carried by reset, and caching only speeds up the small-enough cases. The `'spill'` strategy is declared in the `CacheStrategy` union but **not yet implemented** (`cache-node.ts:9`).

### Optimizer integration (follow-up — must not be skipped)

The cache-insertion decision lives in `MaterializationAdvisory` / `ReferenceGraphBuilder` (`planner/cache/`), driven by per-node `RefStats` (`appearsInLoop`, `parentCount`, `estimatedRows`). Today it recognizes a nested-loop join's inner side as a loop context (`materialization-advisory.ts` Rule 6) and gates caching by size: above `tuning.join.maxRightRowsForCaching` it declines to cache and lets re-execution carry replay.

`FanOutLookupJoinNode` `cross` branches are re-traversed per outer row in exactly the same way, so the advisory must treat them identically. This ticket must verify (and extend if needed) that the reference-graph loop detection marks `cross` branch children as `appearsInLoop`, so the same cache-or-reset decision and the same `maxRightRowsForCaching` size gate apply. If the recognition rule instead inserts a `CacheNode` directly, it must respect the same size gate rather than caching unconditionally. Either way, the large-set path must degrade to reset, never to unbounded buffering.

## Composition

v1 and `cross` share the emitter scaffold (fork + drive via `ParallelDriver`). Only the per-outer-row composition step differs, by cardinality:

- `atMostOne`: collect ≤1 row per branch; NULL-pad (left) or drop (inner).
- `cross`: iterate the n-ary product across the per-branch (cached) relations.

## Recognition

The v1 rule clusters FK→PK at-most-one branches — the safe shape, because the runtime can validate the at-most-one invariant. `cross` recognition is a separate matching pass: every branch is a parameterized lookup with **no** FK→PK alignment (cardinality is data-driven). The `expectedLatencyMs` cost-gate win is identical to the at-most-one case, but the Cartesian-product output row count can be unbounded — so it needs a per-branch row-estimate guard and a maximum-product cap before clustering.

## Out of scope

- **`array` mode (nested-value construction).** Removed from this node entirely — it is not a relational join mode. A correlated `json_group_array` subquery is a scalar aggregate that yields exactly one row per outer row, i.e. an at-most-one branch the v1 path already emits correctly; the JSON shape is whatever the query expresses, never an engine choice. Capturing such subqueries is purely a recognition concern — see `parallel-fanout-lookup-join-aggregate-branch-recognition`.
- Lateral fan-out where branch cardinality is fully data-driven *and* cannot be bounded. Parked by the plan ticket.
- Adaptive ordering of branches by observed latency (issue slowest first).
- Branch-level row-limit propagation (e.g. a downstream `LIMIT 100` informing each `cross` branch to stop early).

## Open questions

- **`cross` empty-branch semantics.** Inner-drop or NULL-pad like LEFT? The nested-loop chain it replaces behaves like an inner cross join (any empty branch → no output rows for that outer), so default to **inner-drop**. A `cross-left` variant could be added later if a replaced chain used LEFT joins. Document and lock with a test.
- **Remote-rescan vs. spill tension (record, don't solve here).** For a *remote* branch the two replay strategies pull in opposite directions: re-execution re-issues the parameterized lookup, re-paying the very round-trip latency the fan-out exists to hide; caching a large per-row result risks memory. The per-outer-row branch result is normally small (one row's lookups), so memory-cache is the sensible default, but the unbounded-remote case is exactly what an implemented `'spill'` strategy would serve. Note it as a consideration; don't block this ticket on spill.

## End
