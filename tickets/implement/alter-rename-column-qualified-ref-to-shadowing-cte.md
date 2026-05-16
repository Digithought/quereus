---
description: Suppress directHit column rewrite when the qualifier resolves to a non-exposing shadowing CTE
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Problem

In `visitColumnRename`'s `column` case, the qualified-ref branch treats
`directHit` (qualifier text == renamed table name) as a rewrite signal
without consulting scope. When a `with t as (...)` clause shadows the
renamed table by name and an inner SELECT uses the **CTE name itself**
as a qualifier (`t.k from t`), the qualifier resolves to the
non-exposing CTE — but `directHit` still rewrites the column to the new
name, corrupting the saved view body.

```sql
create table t (id integer primary key, k integer not null);
create view v as
  with t as (select 0 as k)
  select t.k from t;          -- t.k → the CTE column
alter table t rename column k to kk;
-- v body becomes `select t.kk from t` (within the shadowing CTE).
-- t.kk is not a column of the CTE → view errors.
```

The aliased shape (`from t_shadow2 as a` + `a.k`, test 6h) is already
correct because the qualifier `a` doesn't match the table name, so
`directHit` is false and `aliasResolvesToTable` correctly returns false
(the shadowing branch in `collectFromBindings` records nothing). Only
the **unaliased same-name** shape hits `directHit`.

## Root cause

`collectFromBindings` table case:

```ts
if (ts.table.schema === undefined && isCteInScope(state, name)) {
  if (isCteExposingInScope(state, name)) {
    // ... bind as renamed table
  }
  // Shadowing-but-not-exposing: do not bind as the renamed table.
  break;
}
```

The shadowing-non-exposing branch correctly avoids binding the source
to the renamed table, but it records nothing about the fact that the
source's name is now bound to a CTE. Later, the column-case `directHit`
short-circuit uses only the textual qualifier and `state.tableName`,
ignoring scope entirely.

## Design

Per-frame, track the set of qualifier names that the FROM clause has
bound to non-exposing CTEs (i.e., the source name is shadowed by a
CTE row source). In the qualified column-ref branch, suppress
`directHit` when an innermost-first scope walk hits a shadowing entry
for the qualifier **before** it hits a live binding for the renamed
table.

```ts
interface ScopeFrame {
  unaliased: Set<string>;
  aliasMap: Map<string, string>;
  ctesExposingRenamed: Set<string>;
  ctesInScope: Set<string>;
  // NEW: source names in this frame that resolve to a non-exposing CTE
  // (and therefore must NOT be treated as a direct reference to the
  // renamed real table for qualified column refs).
  ctesShadowingSource: Set<string>;
}
```

In `collectFromBindings`, shadowing-non-exposing branch: record the
source name (only meaningful when unaliased — aliased sources can only
be qualified via their alias, which is already handled correctly):

```ts
if (ts.table.schema === undefined && isCteInScope(state, name)) {
  if (isCteExposingInScope(state, name)) {
    // ... existing exposing-CTE binding logic
  } else if (!ts.alias) {
    frame.ctesShadowingSource.add(name);
  }
  break;
}
```

New helper, innermost-first, with proper precedence vs live bindings:

```ts
function isQualifierShadowedInScope(state: ColumnRewriteState, qualifier: string): boolean {
  for (let i = state.scopeStack.length - 1; i >= 0; i--) {
    const frame = state.scopeStack[i];
    if (frame.ctesShadowingSource.has(qualifier)) return true;
    // Closer rebind to the real table wins → not shadowed at this point.
    if (frame.aliasMap.get(qualifier) === state.tableName) return false;
    if (frame.unaliased.has(qualifier)) return false;
  }
  return false;
}
```

Column case adjustment:

```ts
case 'column': {
  const col = node as AST.ColumnExpr;
  if (col.name.toLowerCase() !== state.oldCol) break;
  if (col.table) {
    const qualifierLower = col.table.toLowerCase();
    const directHit = qualifierLower === state.tableName &&
      (col.schema === undefined || eq(col.schema, state.defaultSchema)) &&
      !isQualifierShadowedInScope(state, qualifierLower);
    const viaAlias = aliasResolvesToTable(state, col.table);
    if (directHit || viaAlias) {
      col.name = state.newCol;
      state.changed = true;
    }
  } else {
    if (isTableInUnaliasedScope(state)) {
      col.name = state.newCol;
      state.changed = true;
    }
  }
  break;
}
```

Notes:

- The unqualified branch (`isTableInUnaliasedScope`) is already correct:
  the shadowing-non-exposing source never adds to `frame.unaliased`, so
  unqualified `k` doesn't rewrite when the only `from t` is a shadowing
  CTE source. Test 6g already covers this.
- The innermost-first walk preserves the legitimate case where an outer
  scope's `from t` is the real table and an inner scope's `from t` is a
  shadowing CTE — each ref resolves against its nearest binding.
- Sibling-CTE shadow (test 6i-style): the outer `from t_sib` source is
  a non-exposing CTE because CTE `t_sib`'s body projects `k` (from
  another CTE `a`, which doesn't expose, so the body's `k` doesn't
  rewrite, so `cteExposesRenamedColumn` returns false). The new fix
  records `t_sib` in `ctesShadowingSource`, so an outer qualified ref
  `t_sib.k` would also be suppressed. (Test 6i uses an unqualified
  ref; the new test 6n covers the qualified shape.)
- Recursive (test 6j-style): the with-clause pre-registers the CTE
  name in `ctesInScope` for recursive WITHs, so the recursive step's
  `from t_rec` source hits `isCteInScope` and falls into the
  shadowing branch; the fix records `t_rec` in `ctesShadowingSource`
  for that frame, so qualified `t_rec.k` inside the recursive step is
  suppressed correctly.

## Tests

Append a new section to
`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`
covering qualified-ref shadowing in three shapes. Use distinct table
names so each case is independent.

### 6m. Non-exposing shadowing CTE — unaliased qualified ref

```sql
create table t_shadow3 (id integer primary key, k integer not null);
insert into t_shadow3 values (1, 100);

create view v_shadow3 as
  with t_shadow3 as (select 0 as k) select t_shadow3.k from t_shadow3;

alter table t_shadow3 rename column k to kk;

select * from v_shadow3;
→ [{"k":0}]

drop view v_shadow3;
drop table t_shadow3;
```

### 6n. Sibling shadowing CTE — qualified ref

```sql
create table t_sib2 (id integer primary key, k integer not null);
insert into t_sib2 values (1, 999);

create view v_sib2 as
  with a as (select 0 as k), t_sib2 as (select k from a)
  select t_sib2.k from t_sib2;

alter table t_sib2 rename column k to kk;

select * from v_sib2;
→ [{"k":0}]

drop view v_sib2;
drop table t_sib2;
```

### 6o. Recursive shadowing CTE — qualified ref in recursive step

```sql
create table t_rec2 (id integer primary key, k integer not null);
insert into t_rec2 values (1, 0);

create view v_rec2 as
  with recursive t_rec2 as (
    select 0 as k
    union all
    select t_rec2.k+1 from t_rec2 where t_rec2.k < 3
  ) select k from t_rec2;

alter table t_rec2 rename column k to kk;

select k from v_rec2 order by k;
→ [{"k":0},{"k":1},{"k":2},{"k":3}]

drop view v_rec2;
drop table t_rec2;
```

Insert after test 6l (line 360) and before section 7. Sequence the new
sub-cases as 6m/6n/6o to extend the existing 6-series.

## TODO

- Add `ctesShadowingSource: Set<string>` to `ScopeFrame`; initialize in
  `emptyFrame()`.
- In `collectFromBindings`, shadowing-non-exposing branch: when
  `!ts.alias`, add `name` to `frame.ctesShadowingSource`.
- Add `isQualifierShadowedInScope` helper (innermost-first, with
  early-return on real-table rebind).
- Update the `column` case in `visitColumnRename` to gate `directHit`
  on `!isQualifierShadowedInScope(state, qualifierLower)`.
- Append sections 6m, 6n, 6o to
  `test/logic/41.3-alter-rename-propagation.sqllogic` with the SQL
  above.
- Run `yarn workspace @quereus/quereus run test` and confirm the new
  cases pass and existing 6a–6l, 6g–6h, 6j–6l still pass.
- Run `yarn workspace @quereus/quereus run lint` (single-quoted globs
  per AGENTS.md if globs are needed) and ensure clean.

## Notes

- Pre-existing latent bug, observed during the review of
  `alter-rename-recursive-cte-self-ref-shadowing`. Not introduced by
  the recursive-CTE fix.
- No store-specific code path touched; `yarn test` suffices.
