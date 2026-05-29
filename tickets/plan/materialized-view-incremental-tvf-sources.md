description: Let incremental materialized-view maintenance bind on lateral / table-valued-function (TVF) source contributions. `materialized-view-incremental-refresh` only binds base-table `TableReferenceNode` sources; a body whose apply key flows through a TVF / lateral source currently classifies `'global'` (full rebuild) or is rejected.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/core/database-materialized-views.ts, docs/optimizer.md, docs/materialized-views.md
----

## Problem

The binding extractor (`extractBindings`) keys on base-table `TableReferenceNode`
instances. A materialized-view body that derives part of its key through a
table-valued function or a lateral subquery has no base-table reference to bind on at
that position, so the source classifies `'global'` and the MV either falls back to full
rebuild on every change or fails the eligibility gate.

TVFs already advertise relational facts via `relationalAdvertisement` (see
`docs/optimizer.md`). The open question is whether that advertisement is enough to
recover a binding key (and a capture spec) for the TVF's *inputs*, so a change to an
input row can drive a bounded per-binding residual through the TVF.

## Expected behavior

A materialized view whose body invokes a TVF / lateral source over a base table can be
declared `with refresh = 'on-commit-incremental'` and maintains incrementally when the
TVF's input rows change — verified against a full-rebuild oracle. Where the
advertisement is insufficient to bound the apply, the source still classifies `'global'`
(full rebuild) rather than producing a wrong result.

## Notes

Proving `relationalAdvertisement` is sufficient (and extending it if not) is the core
research. Captured here so the incremental ticket can stay scoped to base-table sources.
