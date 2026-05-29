description: Incremental maintenance of materialized views whose body contains set operations with bag-distinguishing semantics — UNION (set), INTERSECT, EXCEPT. `materialized-view-incremental-refresh` rejects these at create time under `with refresh = 'on-commit-incremental'`; this ticket makes them maintainable.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, docs/materialized-views.md
----

## Problem

Set semantics make per-binding incremental maintenance hard: deciding whether a
recomputed row should appear in the MV requires knowing the *full* source state for
that binding, not just the changed tuples. A row deleted from one branch of an
`intersect`/`except` may need to appear/disappear based on the other branch's
multiplicity, which the per-binding residual does not see.

`union all` is the exception — it is bag-additive and already eligible (each source
branch contributes independently, so the per-source `'row'`/`'group'` bindings compose).
This ticket covers the bag-distinguishing operators only:

- `union` (distinct) — requires dedup-aware multiplicity tracking.
- `intersect` — requires per-binding multiplicity across both branches.
- `except` — requires knowing whether the right branch still contains the row.

## Expected behavior

`create materialized view ... with refresh = 'on-commit-incremental'` over a body
containing `union` / `intersect` / `except` either (a) maintains correctly on COMMIT,
or (b) continues to error clearly if a given operator remains research-grade. The
acceptance bar is correctness under insert/update/delete on either branch's sources,
verified against a full-rebuild oracle.

## Notes

Likely needs per-branch multiplicity counters in the backing structure (count-based
incremental view maintenance, à la DBToaster/DRed). Scope and approach are open —
this is a research-grade item, captured here so the rejection diagnostic in
`materialized-view-incremental-refresh` has a home to point at.
