---
description: ALTER TABLE RENAME COLUMN wrongly rewrites outer refs when a CTE shadows the renamed table by name
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
prereq:
---

## Problem

The column-rename visitor in `rename-rewriter.ts` resolves an outer `FROM <name>`
to the renamed table whenever `<name>` matches `state.tableName`, regardless of
whether an enclosing WITH-clause defines a CTE with the same name that shadows
the real table.

Concretely:

```sql
create table t_x (id integer primary key, k integer not null);
insert into t_x values (1, 100);

create view v_shadow as with t_x as (select 0 as k) select k from t_x;
-- The outer `from t_x` here refers to the CTE, NOT the real table.
-- The CTE's `k` is a literal alias, unrelated to t_x.k.

alter table t_x rename column k to kk;
```

After the rename, the visitor:
1. Walks the CTE body (`select 0 as k`) — no real-table reference, so the
   exposure analysis correctly classifies the CTE as non-exposing
   (`ctesExposingRenamed` stays empty).
2. Walks the outer `select k from t_x` and pushes a from-frame for `t_x` via
   the standard non-CTE path (`collectFromBindings`). Since
   `t_x === state.tableName`, the standard path adds `t_x` to `frame.unaliased`.
3. Resolves unqualified `k` against the unaliased scope → rewrites to `kk`.

The view body becomes `with t_x as (select 0 as k) select kk from t_x`, which
no longer parses/resolves (the CTE has no `kk`). The view is broken even though
the rename has nothing to do with what it actually returns.

The 3-alter-rename-propagation-cte-in-view ticket flagged this scenario but
explicitly left it out of scope (the implementer's known-gap #1).

## Approach

`collectFromBindings` needs to know whether a `TableSource` name is shadowed by
a CTE in the current scope chain. The shape of the fix:

- Track every CTE name in the with-frame (not just the ones that re-expose the
  renamed column). Add a sibling set `ctesInScope: Set<string>` to `ScopeFrame`,
  populated from every CTE in `pushWithFrame` / `analyzeWithFrame`.
- In `collectFromBindings`'s `case 'table'`, when `ts.table.schema === undefined`
  and `name` matches a CTE in scope:
  - If the CTE is in `ctesExposingRenamed` → keep current behavior (bind as renamed table).
  - Otherwise → the CTE shadows. Add to `frame.unaliased` / `frame.aliasMap`
    under the CTE name itself (not `state.tableName`), so column refs targeting
    the renamed table's columns inside this scope do NOT rewrite.

Edge cases worth covering once the fix lands:

- Shadowing in nested SELECTs: outer CTE shadows, inner subquery FROM uses the
  real table name (no inner CTE) → inner rewrites should still apply.
- Shadowing CTE that *also* happens to re-expose: classification is determined
  by `cteExposesRenamedColumn`; if it returns true, rewrite. If false, treat as
  shadowing.

## Acceptance

- Add a test case to `41.3-alter-rename-propagation.sqllogic` (alongside the
  existing 6/6a–6f sections) demonstrating the shadowing scenario above —
  query against the view should return `[{"k":0}]` and the rename should not
  break it.
- No regressions in existing 41.3 sections.
- `yarn lint` clean.
