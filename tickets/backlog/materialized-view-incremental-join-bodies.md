description: Extend `on-commit-incremental` materialized-view maintenance to multi-source (join) bodies. v1 rejects any body that reads more than one base table at create time; a join MV must build per-source bindings so a change to *either* side recomputes the affected slice.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

## Problem

`MaterializedViewManager.compile()` only handles **single-source** bodies: it
collects `TableReferenceNode`s and throws `UNSUPPORTED`
(`'on-commit-incremental' refresh supports single-source bodies in v1`) when the
body reads more than one base table. The binding synthesis derives a single
`'row'`/`'group'` binding on that one source's identity.

A join body (e.g. `select o.id, c.name, o.total from orders o join customers c
on o.cust_id = c.id`) needs **per-source** maintenance bindings: a change on
`orders` recomputes the rows for the changed order keys; a change on `customers`
recomputes every MV row whose `cust_id` matches a changed customer. Each source's
delta must map to the right slice of the MV's physical primary key, and the
residual must be parameterized on whichever source changed.

This was explicitly deferred by `materialized-view-incremental-refresh` (the
plan envisioned join MVs; the implementation scoped them out). Tracked in
`docs/materialized-views.md` (§ Out of scope / roadmap → Incremental refresh,
"Remaining work: multi-source / join bodies").

## Expected behaviour

- A multi-source join body created `with refresh = 'on-commit-incremental'` is
  accepted at create (subject to per-source eligibility) instead of rejected.
- A mutation to **any** participating source maintains the MV incrementally at
  COMMIT; the MV equals a full re-materialization of the body.
- When a source's change-to-MV-key mapping isn't clean, that source's delta
  falls back to a full rebuild (the existing always-correct escape), rather than
  rejecting the whole MV.

## Notes / directions (non-binding)

- The kernel (`DeltaExecutor`) already supports multiple `relationKey` bindings
  per subscription — the gap is the manager's *synthesis* of those bindings and
  the per-source delete-key projection (`computeDeleteKeyOrder`), which currently
  assumes one source.
- Inner vs outer joins differ: an outer join's null-extended rows complicate the
  delete-then-recompute slice. Consider scoping the first cut to inner joins.
- Reuse `injectKeyFilter` per source (it already targets a single
  `TableReferenceNode` by relation key).

## Use case

Denormalized read models that flatten a parent/child or lookup join into one
keyed relation maintained at commit.
