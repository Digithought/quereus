description: Extend `on-commit-incremental` materialized-view maintenance to aggregate-over-join bodies (a `GROUP BY` whose source is a join, e.g. `select c.id, sum(o.total) from orders o join customers c on o.cust_id = c.id group by c.id`). The single-source aggregate path and the inner-join row-preserving path both exist; their combination is deferred.
prereq: materialized-view-incremental-join-bodies
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

## Problem

`MaterializedViewManager.compile()` supports:

- single-source **aggregate** bodies (`GROUP BY` over bare source columns ⇒
  per-group binding), and
- multi-source **row-preserving** inner-join bodies (per-source row binding) once
  `materialized-view-incremental-join-bodies` lands.

It does **not** support an aggregate *over* a join: when `findAggregate` returns a
node and the body reads more than one source, the inner-join cut rejects with
UNSUPPORTED ("aggregate over a join … use `manual` refresh").

The hard part is the binding synthesis: a change on either join source must map to
the affected **group key(s)** of the aggregate, recompute those groups by
re-running the join-restricted residual, and delete-then-upsert the group rows.
The group key may be sourced from one side of the join while the changed row is on
the other, so the change-to-group-key mapping is non-trivial (and OLD/NEW group
transitions apply per source).

## Expected behaviour

- An aggregate-over-join body created `with refresh = 'on-commit-incremental'` is
  accepted (subject to per-source eligibility) instead of rejected.
- A mutation to any participating source recomputes exactly the affected
  aggregate group(s); the MV equals a full re-materialization.
- Where a source's change cannot be mapped cleanly to group keys, that source's
  delta falls back to a full rebuild (always correct).

## Use case

Denormalized rollups that aggregate a fact table joined to dimension/lookup tables
(e.g. per-customer order totals) maintained at commit.
