description: True count-based incremental maintenance of set-operation MV bodies (`union`/`intersect`/`except`) — and a per-binding bag-additive fast path for `union all` — replacing the whole-MV `'global'` full rebuild that `materialized-view-incremental-set-ops` delivers as the correctness-first baseline.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/delta-executor.ts, docs/incremental-maintenance.md, docs/materialized-views.md
----

## Problem

`materialized-view-incremental-set-ops` makes set-operation `on-commit-incremental`
MV bodies *correct* by classifying the whole MV as `'global'` and re-deriving the
entire body via `rebuildBacking` on any source commit. That is always correct but
re-materializes the full result for even a one-row source change — there is no
per-row fast path.

This ticket replaces that with genuinely incremental maintenance, mirroring the
relationship between `materialized-view-incremental-recursive-cte` (global rebuild)
and `materialized-view-recursive-semi-naive-delta` (true delta).

## What true-delta requires

Set semantics need **multiplicity-aware** maintenance: whether a recomputed row
belongs in the MV depends on the full per-branch state, not just the changed
tuples (count-based IVM / DBToaster Z-relations / DRed):

- **`union` (distinct)** — track per-row multiplicity across both branches; a row
  leaves the MV only when its count reaches zero in *both* branches.
- **`intersect`** — maintain per-branch counts; a row is present iff both branches'
  counts are ≥ 1. A delete from one branch can evict a row the other still holds.
- **`except`** — present iff left count ≥ 1 and right count = 0. A right-branch
  delete can *add* a row to the result; a right-branch insert can remove one.

The backing structure likely needs per-branch multiplicity counters (a hidden
count column or a side index), maintained at COMMIT from each branch's per-binding
delta, with the visible MV row derived from the counter predicate above.

- **`union all` per-binding fast path** — bag-additive, so each branch's rows pass
  through independently and the per-source `'row'`/`'group'` bindings *should*
  compose without multiplicity tracking. The open problem is the backing-PK delete
  mapping across two branches with *distinct* sources (each branch's
  `computeDeleteKeyOrder` targets the same backing PK from a different source). This
  is a smaller lift than the bag-distinguishing operators and could land first.

## Acceptance bar

Correctness under insert/update/delete on either branch's sources, verified against
the full-rebuild oracle (the `'global'` path this replaces is itself that oracle),
**plus** a demonstrated per-row cost win: a one-row source change must not
re-materialize the whole body (assert via maintenance-op counts or a
`rebuildBacking` spy, the way the per-binding join tests do).

## Notes

Research-grade. The `'global'` rebuild from `materialized-view-incremental-set-ops`
remains the correct fallback (and the cost-fallback demotion target) for any shape
this delta path does not cover.
