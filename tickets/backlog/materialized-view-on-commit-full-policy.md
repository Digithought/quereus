description: A third materialized-view refresh policy, `on-commit-full`, that does a full rebuild of the backing table at every COMMIT that touches a source — between `manual` (rebuild only on explicit REFRESH) and `on-commit-incremental` (per-binding delta apply).
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/schema/view.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/core/database-materialized-views.ts, docs/materialized-views.md
----

## Use case

Some bodies are not incrementally maintainable (set-ops, recursive CTEs, TVF sources)
but still want auto-freshness without the user issuing `REFRESH`. `on-commit-full`
rebuilds the whole backing table on every COMMIT that modifies a source — semantically
a `REFRESH MATERIALIZED VIEW` fired automatically post-commit.

This is mechanically close to the existing cost-fallback path in
`materialized-view-incremental-refresh` (which already rebuilds the backing table via
the shared `rebuildBacking` helper when a binding is `'global'` or the cost cliff
fires). `on-commit-full` would route *every* source change through that same rebuild,
skipping eligibility analysis and per-binding residual compilation entirely.

## Expected behavior

```sql
create materialized view mv with refresh = 'on-commit-full' as select ...;
```

- Any source change → full rebuild at COMMIT (post-commit phase, errors logged-and-
  dropped, never rolls the user commit back — same contract as incremental).
- No eligibility gate: any valid view body is accepted (this is the escape hatch for
  bodies that can't be maintained incrementally).
- `getChangeScope()` reports the source union (same as incremental), since the MV's
  freshness now tracks source mutations.

## Why deferred

Adds a third dimension to MV semantics for a feature whose value is unproven; build it
when a real workload wants auto-fresh-but-non-incremental MVs. The incremental ticket
deliberately keeps the policy enum at two variants so the default (`manual`) and the
incremental path are the only shipped semantics.
