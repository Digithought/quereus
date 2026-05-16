---
description: Pre-register recursive CTE names in scope before visiting their bodies so self-references aren't mistaken for the renamed table
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Background

See the fix ticket for full root-cause analysis. In short:
`pushWithFrame` in `packages/quereus/src/schema/rename-rewriter.ts`
visits each CTE body *before* registering the CTE name in
`frame.ctesInScope`. That ordering is correct for non-recursive WITHs
(a non-recursive body must not see itself), but for `with recursive`
CTEs the body must see itself — otherwise a `FROM <cte-name>` inside
the recursive step is treated as the renamed real table, and
column-rename rewriting corrupts the body.

The bug only manifests when the recursive CTE omits an explicit column
list (the column-list path short-circuits exposure analysis), so
practical impact is low — but the rewrite is still wrong.

## Fix

In `pushWithFrame`, when `withClause.recursive === true`, register each
CTE's name in `frame.ctesInScope` *before* visiting its body. For
non-recursive WITHs, keep the existing ordering. `ctesExposingRenamed`
is still computed after the body is visited (post-body analysis).

Sketch:

```ts
for (const cte of withClause.ctes) {
  const nameLower = cte.name.toLowerCase();
  if (withClause.recursive) {
    frame.ctesInScope.add(nameLower);
  }
  visitColumnRename(cte.query, state);
  if (cteExposesRenamedColumn(cte, state)) {
    frame.ctesExposingRenamed.add(nameLower);
  }
  frame.ctesInScope.add(nameLower); // idempotent on the recursive path
}
```

Note: pre-registering before body-visit means the CTE name is in scope
during the body's own exposure analysis too — that's the desired
behavior (self-ref inside the body is a CTE reference, not the renamed
table).

## Tests

Add a new section `6j` (and `6k`) in
`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`:

- `6j` — Recursive CTE named same as renamed table, **no column list**,
  with a self-reference. The unqualified `k` inside `select k+1 from t
  where k < 3` must remain `k` (resolves to the CTE column), not `kk`.
  Verify the view still works after the rename. The view's outer
  `select k from t` is already preserved by the existing shadowing
  fix — `6j` adds coverage for the recursive-step body.

- `6k` — Same shape but with an explicit column list (`t(k)`).
  Already passes today via the column-list short-circuit; add as
  regression guard.

Use the example from the fix ticket as the basis:

```sql
create table t (id integer primary key, k integer not null);
insert into t values (1, 0);
create view v as
  with recursive t(k) as (
    select 0
    union all
    select k+1 from t where k < 3
  ) select k from t;
alter table t rename column k to kk;
select k from v order by k;
-- expected: 0, 1, 2, 3
```

For the no-column-list variant the body must produce a single column
whose unaliased name carries through naturally (e.g. `select 0 as k …
select k+1 from t where k < 3`). Confirm the rewritten view body still
parses and executes; the outer `select k from t` is the CTE projection
(unaffected by the rename), so the result column should remain `k`.

## TODO

- Update `pushWithFrame` per the sketch above; keep the recursive
  branch minimal and DRY.
- Add `6j` + `6k` cases to `41.3-alter-rename-propagation.sqllogic`.
- Run `yarn test` and confirm 41.3 passes; spot-check that no other
  ALTER-rename or WITH-recursive test regressed.
- Run `yarn workspace @quereus/quereus run lint` (single-quoted globs
  on Windows).
- Hand off to review/ with notes on which assertions were added.
