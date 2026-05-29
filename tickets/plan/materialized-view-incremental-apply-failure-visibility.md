description: When incremental materialized-view maintenance fails mid-apply, the MV silently misses that commit's delta and diverges from its source with no error on subsequent reads. Give a failed apply a visible signal (e.g. mark the MV stale, or auto-schedule a rebuild) instead of silent log-and-skip.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, docs/materialized-views.md
----

## Problem

`MaterializedViewManager.buildSubscription().apply` wraps the whole maintenance
batch in a `try/catch` that logs (`warnLog`) and returns — "maintenance failure
logs-and-skips; the user's commit stands". This matches the `on-commit-incremental`
error policy the implementing ticket chose (the watcher contract, not the
assertion one): a failing MV must never roll the user's commit back.

The hazard is **what happens after**. Ops are collected across all binding tuples
and only handed to `applyMaintenance` once at the end of the loop, so a throw
from `runResidual` mid-collection means **none** of this commit's delta is
applied. The MV is left at its pre-commit contents — it has silently *skipped*
this commit's changes. Nothing re-applies that missed delta: the next commit
maintains only the *next* delta's bindings. The MV therefore diverges from its
source **permanently** until a manual `refresh materialized view`, and reads in
the interim return wrong data with **no staleness flag and no error** — unlike a
source schema change, which sets `stale` and makes reads error.

## Expected behaviour

A maintenance `apply` failure should leave a *visible* signal so reads cannot
silently return diverged data. Candidate approaches (pick after discussion):

- mark the MV `stale` on apply failure, so the next reference errors with the
  staleness diagnostic and the user knows to `refresh` (mirrors schema-change
  invalidation) — simplest, but couples a transient runtime error to the
  schema-staleness path;
- enqueue a deferred full `rebuildBacking` for the MV (self-heal on next
  post-commit pass);
- surface the failure through a diagnostic channel / counter the embedder can
  observe.

The user's commit must still stand (no rollback) regardless of the chosen
signal.

## Notes

- This is a deliberate policy refinement, not a bug in the delivered behaviour —
  the implementing ticket explicitly specified log-and-skip and documented it.
  Filed so the silent-divergence consequence gets a considered decision rather
  than being inherited by default.
- Hard to unit-test today because forcing a deterministic apply error is awkward;
  a fault-injection seam on `runResidual` / `applyMaintenance` would help and
  could land with this work.
