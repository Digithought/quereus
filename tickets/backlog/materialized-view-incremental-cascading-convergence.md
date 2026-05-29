description: Make cascading incremental materialized views (an `on-commit-incremental` MV whose source is itself an incremental MV's backing table) converge within a single COMMIT, instead of lagging one commit per level of nesting.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-transaction.ts, docs/materialized-views.md, docs/incremental-maintenance.md
----

## Problem

Incremental materialized-view maintenance runs in the **post-commit** window
(`TransactionManager` → `runPostCommitMaterializedViews()`), after the user's
connections commit but while the *original* commit's change log is still alive.
A leaf MV's backing-table write is performed there via
`MemoryTableManager.applyMaintenance` / `replaceBaseLayer` — **off** the
user-transaction path, so that write is **not** itself recorded in the current
commit's change log.

Consequently a dependent MV stacked on a leaf MV (`mv2` reads `mv1`'s backing
table) does not see `mv1`'s post-commit write during the same pass. `mv2`
therefore lags: it only catches up on the *next* commit that touches one of its
sources, and a chain of depth N needs up to N commits to fully converge. Reads
of `mv2` in the interim return stale data with no error.

This is referenced as a known limitation in `docs/materialized-views.md`
(§ Incremental refresh → Limitations) and `docs/incremental-maintenance.md`
(§ Third consumer), under this slug.

## Expected behaviour

A `create materialized view mv2 ... with refresh = 'on-commit-incremental'`
whose body reads another incremental MV should reflect a source mutation that
ripples mv1 → mv2 **within the same COMMIT**, with no extra manual refresh and
no transient stale window.

## Notes / directions (non-binding)

- Options to explore: (a) record the maintenance writes into a secondary change
  log and iterate the post-commit maintenance pass to a fixpoint (topologically
  ordered by MV dependency, with a cycle guard); (b) order MVs by dependency and
  feed each level's backing writes as deltas into the next.
- Watch for cycles (MV dependency graph must be a DAG — reject or detect cycles).
- A bounded iteration count + diagnostic on non-convergence is preferable to an
  unbounded loop.

## Use case

Layered derived relations (rollup-on-rollup, denormalized read models built in
tiers) where each tier is an incremental MV over the previous tier.
