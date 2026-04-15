description: Add MATCH SIMPLE NULL guards to child-side FK constraint checks so NULL FK columns satisfy the constraint without evaluating the EXISTS subquery.
dependencies: none
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----

## Problem

Child-side FK constraint checks fail when a nullable FK column is NULL and the parent table is empty.  Per SQL:2016 §4.17.2 MATCH SIMPLE (the default), a child row satisfies the FK whenever **any** of its FK columns is NULL — the EXISTS subquery should not be evaluated at all.

Currently `synthesizeExistsCheck()` in `foreign-key-builder.ts` generates a bare:

```
EXISTS(SELECT 1 FROM parent WHERE parent.pk = NEW.fk)
```

When `NEW.fk` is NULL, this becomes `parent.pk = NULL` → UNKNOWN for every row → no rows → EXISTS = false → CHECK fails.

### Reproduction (confirmed)

```sql
pragma foreign_keys = true;
create table parent_t (id integer primary key);
create table child_t (
  id integer primary key,
  parent_id integer null,
  foreign key (parent_id) references parent_t(id) on delete restrict
);
insert into child_t (id, parent_id) values (1, null);
-- CHECK constraint failed: _fk_child_t_parent_id
```

Same failure for multi-column FKs with any NULL column.

Note: the self-referential case with ON DELETE CASCADE coincidentally passes today because the constraint is deferred (`initiallyDeferred: true`) and an adjacent `col = NULL` evaluation oddity masks the bug. The fix below makes correctness independent of both issues.

## Fix

In `synthesizeExistsCheck()` (lines 55–73), wrap the returned EXISTS expression with an OR-chain of `IS NULL` guards — one per FK column:

```
(NEW.col1 IS NULL) OR (NEW.col2 IS NULL) OR ... OR EXISTS(...)
```

AST shape: each guard is `{ type: 'unary', operator: 'IS NULL', expr: <ColumnExpr for NEW.colN> }`, chained with `{ type: 'binary', operator: 'OR', left: guard, right: existsOrNextGuard }`.

This implements MATCH SIMPLE: the FK passes immediately when any referencing column is NULL.

### What NOT to change

- `synthesizeNotExistsCheck()` / parent-side checks — parent PK columns are non-NULL by definition; no guard needed.
- No MATCH FULL or MATCH PARTIAL support needed (not yet supported; MATCH SIMPLE is the universal default).

## Test coverage to add

In `packages/quereus/test/logic/41-foreign-keys.sqllogic`, extend the NULL section (after line 354) with these cases:

1. **Empty parent + NULL child (RESTRICT)**: create parent, create child with nullable FK ON DELETE RESTRICT, insert child with NULL FK and no parent rows — must succeed.
2. **Self-referential FK, first row NULL**: single-table tree pattern with ON DELETE CASCADE, insert root with `parent_id = NULL` into empty table — must succeed (this already works today due to deferred + oddity, but the test ensures it stays correct after the fix).
3. **Multi-column FK, one NULL column**: per MATCH SIMPLE, any single NULL in the FK column set satisfies the constraint even if other columns have values that wouldn't match. Empty parent table, ON DELETE RESTRICT.
4. **Multi-column FK, all NULLs**: also satisfies. Empty parent, ON DELETE RESTRICT.
5. **Multi-column FK, no NULLs, no match**: must still fail (regression guard).
6. Keep existing `null_parent`/`null_child` test unchanged — it should continue to pass.

## TODO

- [ ] Modify `synthesizeExistsCheck()` in `packages/quereus/src/planner/building/foreign-key-builder.ts` to wrap the EXISTS expression with OR-chained `IS NULL` guards for each FK column. The guard column references should use the same `qualifier` ('new'/'old') and `childTable` column names as the existing pairs.
- [ ] Add the five test cases listed above to `packages/quereus/test/logic/41-foreign-keys.sqllogic` in a new subsection after the existing NULL FK section.
- [ ] Run `yarn workspace @quereus/quereus test` — all tests must pass.
