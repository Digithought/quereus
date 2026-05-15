---
description: Propagate ALTER TABLE RENAME COLUMN through CTEs in view bodies
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Problem

`renameColumnInAst` recurses into CTE bodies (so `select k from t_cte` inside a CTE
gets rewritten to `select kk from t_cte`), but the outer `select k from c` is left
untouched because the visitor's scope model only tracks real table sources, not CTE
bindings. After `alter table t_cte rename column k to kk`, the view's stored AST still
references `k` outside the CTE and the view fails to resolve.

Section 6 of `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` is
commented out (lines 106–122) waiting on this fix.

## Approach

Extend the column-rename visitor in `packages/quereus/src/schema/rename-rewriter.ts`
to track CTEs that "re-expose" the renamed column under the same (unaliased) name.
When an outer FROM clause references such a CTE, treat the CTE binding the same way
the visitor already treats the renamed table itself.

### When does a CTE "re-expose" the renamed column?

After recursively rewriting a CTE's body, examine its result columns. The CTE exposes
the renamed column iff:

- The CTE has **no** column list (`with c(...) as ...` — explicit column list is a form
  of aliasing; do not propagate), **and**
- At least one result column is a passthrough of the renamed column under name
  `oldCol`:
  - `{type:'all', table?: T}` where `T` is undefined and the renamed table is in the
    inner SELECT's unaliased scope, OR `T` is an alias / unqualified reference to the
    renamed table.
  - `{type:'column', expr, alias}` where `alias` is undefined and `expr` is a
    `ColumnExpr` that, after rewriting, refers to `state.newCol` qualified to (or
    unqualified-resolving to) the renamed table.

Explicit `alias` on the projection — even if `alias === oldCol` — stops propagation
(matches the ticket's "aliased projections should not propagate" rule).

### Scope-stack extension

```ts
interface ScopeFrame {
  unaliased: Set<string>;            // existing — table names exposing the renamed col
  aliasMap: Map<string, string>;     // existing — alias → table name (lowercase)
  ctesExposingRenamed: Set<string>;  // NEW — CTE names (lowercase) declared in this
                                     // SELECT's WITH that re-expose the renamed col
}
```

A SELECT now pushes **two** frames:

1. A *with-frame* (built before walking CTE bodies) whose `ctesExposingRenamed` set is
   populated as each CTE is visited and analyzed. This makes earlier CTEs visible to
   later ones in the same WITH (`with a as (...), b as (select k from a) ...`).
2. The existing *from-frame* built from `stmt.from`. When building this frame, a
   `TableSource` whose name matches a CTE in **any** ancestor with-frame's
   `ctesExposingRenamed` is treated as a binding to the renamed table:
   - unaliased → adds `state.tableName` to `frame.unaliased`
   - aliased → adds `alias → state.tableName` to `frame.aliasMap`

This keeps `isTableInUnaliasedScope` and `aliasResolvesToTable` unchanged at the
resolution site — the CTE is plugged in as if it were the renamed table.

### Ordering

Process CTEs in declaration order so later CTEs see the earlier with-frame additions.
For each CTE: visit its `query` first (which may itself contain nested WITHs and is
handled by the same recursion), then post-analyze its result columns to decide
exposure, then add to the with-frame if exposing.

Recursive CTEs are out of scope — they almost always carry a column list and so won't
propagate by the rule above. No special handling needed.

### Apply consistently to all statement kinds with `withClause`

`SelectStmt`, `InsertStmt`, `UpdateStmt`, `DeleteStmt` all carry an optional
`withClause`. Today only the SELECT case is reached by `propagateColumnRename` (it
walks view bodies and CHECK constraints), but the visitor should be self-consistent —
add the with-frame push around the `withClause?.ctes.forEach(...)` call in all four.

## Test cases to add to `41.3-alter-rename-propagation.sqllogic`

1. **Uncomment section 6** as-is (the basic CTE-in-view case).
2. **Aliased projection stops propagation** — after rename, refs to the aliased name
   in the outer SELECT must NOT be rewritten:
   ```sql
   create table t_a (id integer primary key, k integer not null);
   insert into t_a values (1, 10);
   create view v_a as with c as (select k as kk_alias from t_a) select kk_alias from c;
   alter table t_a rename column k to kk;
   select * from v_a;
   -- → [{"kk_alias":10}]
   ```
3. **Explicit CTE column list stops propagation** —
   ```sql
   create view v_cl as with c(x) as (select k from t_x) select x from c;
   alter table t_x rename column k to kk;
   -- view's outer refs to x stay as x; inner k → kk
   select * from v_cl;
   ```
4. **Multi-CTE chain propagates through every link** —
   ```sql
   create view v_chain as with a as (select k from t_chain), b as (select k from a) select k from b;
   alter table t_chain rename column k to kk;
   select * from v_chain;
   ```
5. **CTE inside a subquery in the view body** —
   ```sql
   create view v_sub as select * from (with c as (select k from t_sub) select k from c) s;
   alter table t_sub rename column k to kk;
   select * from v_sub;
   ```
6. **`select *` in the CTE body** — passthrough via star expansion should also propagate:
   ```sql
   create view v_star as with c as (select * from t_star) select k from c;
   alter table t_star rename column k to kk;
   select * from v_star;
   ```

## Acceptance

- Section 6 of `41.3-alter-rename-propagation.sqllogic` un-commented and passing.
- New tests above added and passing.
- All existing tests still pass (section 5 plain-view propagation, sections 8/10/11
  table/column-rename propagation, etc.) — no regressions.
- `yarn workspace @quereus/quereus run lint` clean.

## TODO

- Extend `ScopeFrame` with `ctesExposingRenamed: Set<string>` in
  `packages/quereus/src/schema/rename-rewriter.ts`.
- Refactor `case 'select'` in `visitColumnRename` to push a with-frame, walk CTEs in
  order, post-analyze each CTE's exposure, then push the from-frame.
- Apply the same with-frame logic to `case 'insert'`, `case 'update'`, `case 'delete'`
  (their existing `stmt.withClause?.ctes.forEach(...)` should be wrapped equivalently).
- Update `buildScopeFrame` (or its `collectFromBindings` helper) to accept the current
  scope stack and consult ancestor with-frames so that a `TableSource` referencing a
  renamed-col-exposing CTE contributes to `unaliased` / `aliasMap` as if it were the
  renamed table.
- Write a `cteExposesRenamedColumn(cte, state)` helper that:
  - Returns `false` if `cte.columns` is defined.
  - For each result column in `cte.query.columns`, returns `true` on the first
    passthrough match per the rules above.
- Uncomment section 6 of `41.3-alter-rename-propagation.sqllogic` and add the new
  test cases listed above.
- Run `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log` and confirm
  green. Run `yarn workspace @quereus/quereus run lint` and confirm clean.
