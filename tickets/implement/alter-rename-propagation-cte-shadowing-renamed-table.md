---
description: ALTER TABLE RENAME COLUMN wrongly rewrites outer refs when a CTE shadows the renamed table by name
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
prereq:
---

## Problem

The column-rename visitor in `rename-rewriter.ts` resolves an outer
`FROM <name>` to the renamed table whenever `<name>` matches
`state.tableName`, regardless of whether an enclosing WITH-clause defines a
CTE with the same name that shadows the real table.

Repro (the test case added in section 6g of 41.3):

```sql
create table t_shadow (id integer primary key, k integer not null);
insert into t_shadow values (1, 100);
create view v_shadow as with t_shadow as (select 0 as k) select k from t_shadow;
-- The outer `from t_shadow` refers to the CTE, NOT the real table.
alter table t_shadow rename column k to kk;
select * from v_shadow;  -- must remain [{"k":0}]
```

Before the fix, the visitor treated the outer `from t_shadow` as the renamed
table and rewrote the unqualified `k` to `kk`, breaking the view.

## Resolution

Track every CTE name in scope, not just CTEs that re-expose the renamed
column. When a `TableSource` in `collectFromBindings` references a name that
is shadowed by a CTE in scope:

- If the CTE re-exposes the renamed column → bind the source as if it were
  the renamed table (preserves existing 6/6a–6f behavior).
- Otherwise → skip the standard "renamed-table" binding entirely so that
  unqualified column refs in this scope do not rewrite.

Changes in `packages/quereus/src/schema/rename-rewriter.ts`:

- `ScopeFrame` now carries `ctesInScope: Set<string>` alongside
  `ctesExposingRenamed`.
- `pushWithFrame` / `analyzeWithFrame` populate `ctesInScope` for every CTE
  in declaration order (so siblings see each other and the outer SELECT sees
  all of them, but a CTE body does not see itself — preserves non-recursive
  shadowing semantics).
- `collectFromBindings` `case 'table'` checks `isCteInScope` before the
  standard renamed-table binding; the previous exposing-CTE branch becomes a
  sub-case of the generic shadowing branch.
- New helper `isCteInScope` mirrors `isCteExposingInScope`.

Test: section 6g added to `41.3-alter-rename-propagation.sqllogic` covers
the shadowing scenario.

## Verification

- [x] `yarn test` (3157 passing — no regressions in 41.3 sections 6/6a–6f).
- [x] `yarn lint` clean.

## Hand-off

Ready for review. The fix is minimal and self-contained: it only adds a
shadowing-aware branch on the inbound side (`collectFromBindings`) plus a
new scope-tracking set. Existing exposure-analysis behavior for re-exposing
CTEs is preserved.
