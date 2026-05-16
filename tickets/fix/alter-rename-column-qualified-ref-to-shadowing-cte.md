---
description: Qualified column ref using the renamed table's own name as qualifier inside a non-exposing shadowing CTE is wrongly rewritten
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Symptom

When a `with` clause declares a CTE whose name matches the renamed
table, and a query inside that CTE's visibility uses the **CTE name
itself** as the qualifier of a column reference, `renameColumnInAst`
still rewrites the column to the new name even though the qualifier
resolves to the (non-exposing) CTE, not the real table.

Example:

```sql
create table t (id integer primary key, k integer not null);
create view v as
  with t as (select 0 as k)
  select t.k from t;          -- t.k here refers to the CTE's column
alter table t rename column k to kk;
-- After rewrite the view body is corrupted: `t.kk` (column not found).
```

Test 6h in `41.3-alter-rename-propagation.sqllogic` covers the case
where the source has an alias (`from t_shadow2 as a` + `a.k`); the
alias goes through `aliasResolvesToTable`, which correctly returns
false. The unaliased qualified case takes a different code path that
ignores scope.

## Root cause

In `packages/quereus/src/schema/rename-rewriter.ts`, the `column`
case in `visitColumnRename`:

```ts
if (col.table) {
  const qualifierLower = col.table.toLowerCase();
  const directHit = qualifierLower === state.tableName &&
    (col.schema === undefined || eq(col.schema, state.defaultSchema));
  const viaAlias = aliasResolvesToTable(state, col.table);
  if (directHit || viaAlias) {
    col.name = state.newCol;
    state.changed = true;
  }
}
```

`directHit` is `true` whenever the qualifier text equals the renamed
table's name, regardless of whether the qualifier resolves to a
shadowing CTE in the current scope. `collectFromBindings` already
takes a "shadowing-but-not-exposing" branch that intentionally adds
nothing to the scope frame for such sources, but the `directHit`
short-circuit doesn't consult scope at all.

## Fix sketch

Before treating `directHit` as a rewrite signal, check whether the
qualifier (which equals the table name) actually resolves to the
renamed real table in the current scope. If a non-exposing CTE with
the same name is in scope and the source row was suppressed by the
shadowing branch, the qualifier is a CTE reference and must not
rewrite.

Concretely, one option is: extend `collectFromBindings`'s shadowing
branch to also record the shadowed name in a per-frame
`ctesShadowingTable: Set<string>` (or similar), then in the column
case, treat `directHit` as live only when no in-scope frame marks the
name as shadowed.

Alternative: change `directHit` to require that the renamed table is
*in unaliased scope* (`isTableInUnaliasedScope(state)`) — but that
would break legitimate qualified refs to the renamed table when it
also appears unaliased somewhere outer; needs care.

## Tests to add

A new section in `41.3-alter-rename-propagation.sqllogic`:

- Shadowing CTE (non-exposing) with an unaliased qualified ref to the
  CTE column: `with t as (select 0 as k) select t.k from t`. After
  `alter table t rename column k to kk`, the view must still return
  `[{"k":0}]`.

- Sibling shadowing case, qualified ref: `with a as (select 0 as k),
  t as (select k from a) select t.k from t`.

- Recursive shadowing case, qualified ref inside the recursive step:
  `with recursive t as (select 0 as k union all select t.k+1 from t
  where t.k < 3) select k from t`.

## Notes

- Pre-existing latent bug, observed during the review of
  `alter-rename-recursive-cte-self-ref-shadowing`. Not introduced by
  the recursive-CTE fix and not regressed by it.
- Practical impact: naming a CTE the same as a real table is
  uncommon; qualifying with that name is less common still. Low
  priority but real correctness gap.
