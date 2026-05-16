---
description: Recursive CTE whose name shadows the renamed table mis-rewrites self-references inside its body
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Symptom

When a view body declares a `with recursive` CTE whose name happens to
match the renamed table, the recursive step's self-reference (a `FROM
<cte-name>` inside the CTE body) is treated as the renamed real table
rather than as the CTE. Unqualified / qualified column refs in the
recursive step are then rewritten to the new column name, even though
they should refer to the CTE's own column.

Concretely, given:

```sql
create table t (id integer primary key, k integer not null);
create view v as
  with recursive t(k) as (
    select 0
    union all
    select k+1 from t where k < 3
  ) select k from t;
alter table t rename column k to kk;
```

The outer `select k from t` is correctly preserved (closed by
`alter-rename-propagation-cte-shadowing-renamed-table`), but the
recursive-step body `select k+1 from t where k < 3` still has its `k`s
rewritten to `kk`. Since the CTE has a column list `t(k)`, the view
still works in practice — the column-list path short-circuits exposure
analysis. The latent bug surfaces only when the recursive CTE omits an
explicit column list (uncommon but legal).

## Root cause

In `pushWithFrame` (`packages/quereus/src/schema/rename-rewriter.ts`),
each CTE's body is visited *before* the CTE is added to
`frame.ctesInScope`:

```ts
for (const cte of withClause.ctes) {
  visitColumnRename(cte.query, state);            // body visited first
  if (cteExposesRenamedColumn(cte, state)) {
    frame.ctesExposingRenamed.add(cte.name.toLowerCase());
  }
  frame.ctesInScope.add(cte.name.toLowerCase()); // then added
}
```

This ordering is correct for *non-recursive* CTEs (a non-recursive
body must not see itself). For recursive CTEs (`withClause.recursive
=== true`), the body MUST see itself — so the CTE name should be in
scope while the body is being visited.

## Fix sketch

When `withClause.recursive` is true, add each CTE name to
`frame.ctesInScope` *before* visiting its body (`ctesExposingRenamed`
can still be deferred — that's a post-body analysis). For
non-recursive CTEs the existing ordering is correct and should be
preserved.

## Tests to add

A new section in `41.3-alter-rename-propagation.sqllogic` covering:
- `with recursive` CTE named same as renamed table, no column list,
  with a self-reference; verify the rename does not corrupt the body.
- Same shape but with an explicit column list (should already pass —
  guards against regression of the column-list short-circuit).

## Notes

- Pre-existing issue; not regressed by the shadowing fix that closed
  `alter-rename-propagation-cte-shadowing-renamed-table`. Filed as a
  follow-up out of that review.
- Practical impact is small (recursive CTEs typically use column
  lists). Low priority but real.
