---
description: ALTER TABLE RENAME COLUMN no longer rewrites outer refs when a CTE shadows the renamed table by name
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Summary

Closes the shadowing gap that fell out of the prior review of
`alter-rename-propagation-cte-in-view`. When a view body declares a CTE
whose name happens to match the renamed table, an outer `from <name>`
unambiguously refers to the CTE, not the real table — yet the column
renamer previously treated the FROM as the renamed table and rewrote
unqualified column refs in the outer SELECT.

Repro (now section **6g** in the regression suite):

```sql
create table t_shadow (id integer primary key, k integer not null);
insert into t_shadow values (1, 100);
create view v_shadow as
  with t_shadow as (select 0 as k) select k from t_shadow;
alter table t_shadow rename column k to kk;
select * from v_shadow;
-- expected: [{"k":0}]
```

## Change

`packages/quereus/src/schema/rename-rewriter.ts`:

- `ScopeFrame` gains a `ctesInScope: Set<string>` alongside the existing
  `ctesExposingRenamed`. `ctesInScope` is the superset — every CTE
  declared in this WITH, regardless of whether it re-exposes the renamed
  column.
- `pushWithFrame` and `analyzeWithFrame` both populate `ctesInScope` in
  declaration order (so later CTEs in the same WITH see earlier
  siblings, the outer SELECT sees all of them, and a CTE body does not
  see itself — preserves non-recursive shadowing semantics).
- New helper `isCteInScope` mirrors `isCteExposingInScope`.
- `collectFromBindings` `case 'table'` now branches on
  `isCteInScope(state, name)` *before* the standard renamed-table
  binding. The existing exposing-CTE behaviour becomes a sub-case:
  - shadowed + exposing → bind as the renamed table (preserves 6 / 6a–6f).
  - shadowed + not exposing → skip the binding entirely; unqualified
    refs in this scope do not rewrite.
  - not shadowed → fall through to the original renamed-table logic.

`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`
gains section **6g** covering the non-exposing shadowing case.

## What to validate in review

The fix is small and self-contained, but the renamer is a recursive
visitor with several scope frames — worth poking at:

- **Shadowing semantics across scope nesting.** The CTE-body-does-not-
  see-itself rule depends on adding `ctesInScope` *after* visiting the
  body in `pushWithFrame`. Confirm a CTE named `t` whose body is
  `select k from t` (referencing the real table `t` via self-shadowing
  rules) still rewrites correctly. Worth a manual trace or a 6h-style
  test.
- **Schema-qualified shadowing.** `from main.t_shadow` should bypass the
  CTE-in-scope branch (CTE refs cannot carry a schema). Current code
  gates the shadow branch on `ts.table.schema === undefined` — looks
  right but worth confirming there's no off-by-one with the default
  schema.
- **Aliased shadowing.** `from t_shadow as a` where `t_shadow` is a
  shadowing-but-not-exposing CTE: the code currently breaks without
  binding the alias, so qualified `a.k` will not rewrite — correct,
  because `a.k` resolves to the CTE column, not the real column. Worth
  adding to the matrix.
- **Sibling-CTE shadowing inside a multi-WITH.** `with a as (select 0 as k),
  t_shadow as (select k from a) select k from t_shadow` — sibling
  ordering should already cover this via the `ctesInScope.add()`
  placement, but verify.
- **Recursive CTE shadowing.** Same as above plus a self-reference.
  Existing exposure analysis short-circuits when a CTE has a column
  list; recursive CTEs without one are unusual but worth tracing.
- **Update/Delete with `WITH`.** UPDATE/DELETE both call
  `pushWithFrame` then push a target-table frame. A shadowing CTE in
  the UPDATE/DELETE's WITH that masks the target name is unlikely in
  practice but should at minimum not crash.

## Verification done

- `yarn workspace @quereus/quereus run build` — exits 0.
- `yarn workspace @quereus/quereus run test` — 3157 passing, 48s,
  no regressions in 41.3 sections 6/6a–6f.
- `yarn workspace @quereus/quereus run lint` — exits 0, no output.
- `yarn test:store` deferred per AGENTS.md guidance (no store-specific
  code touched).

## Known gaps / honest notes

- The new test matrix is a single positive case (6g). The "what to
  validate" list above flags several adjacent cases (aliased shadow,
  schema-qualified shadow, sibling shadow, recursive shadow) that are
  not yet covered — reviewer should decide whether to add inline or
  spawn follow-ups.
- The implementation only touches the inbound side
  (`collectFromBindings`); exposure analysis in `cteExposesRenamedColumn`
  was not revisited. If a CTE both shadows the renamed table *and*
  attempts to re-expose a column under the same name from a nested
  scope, the exposure path may still trip — manual trace recommended.
- The pre-existing subquery-without-CTE gap (`select k from (select k from t) s`)
  flagged in the prior ticket's review remains untouched; out of scope
  here.

## End
