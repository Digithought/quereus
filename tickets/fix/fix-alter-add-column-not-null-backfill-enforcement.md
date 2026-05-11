----
description: ALTER TABLE ADD COLUMN with a NOT NULL constraint and no DEFAULT against a non-empty table should fail (per SQL standard and SQLite semantics); the Quereus alter-table builder currently accepts it silently. Scope-extension on `1-fix-alter-add-column-constraint-enforcement` (complete) which added CHECK and FK enforcement but did not cover the NOT-NULL-without-DEFAULT backfill case. The corpus-clarification ticket `41-alter-table-not-null-corpus-drift` (complete) made the assertion explicit but did not add enforcement.
prereq:
files:
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/test/logic/41-alter-table.sqllogic
  tickets/complete/1-fix-alter-add-column-constraint-enforcement.md
  tickets/complete/41-alter-table-not-null-corpus-drift.md
----

## What's failing

`packages/quereus/test/logic/41-alter-table.sqllogic:126-132`:

```sql
create table t_notnull (id integer primary key);
insert into t_notnull values (1), (2);
-- run

-- NOT NULL without DEFAULT should fail (table has rows)
alter table t_notnull add column required text not null;
-- error: NOT NULL
```

The assertion is explicit (post-`41-alter-table-not-null-corpus-drift`) and matches SQLite: ADD COLUMN with NOT NULL on a non-empty table without a DEFAULT cannot succeed because existing rows have nothing to put in the new column. Quereus's `runAddColumn` accepts the column anyway. The downstream lamina-on-quereus harness (`packages/lamina-quereus-test/src/sqllogic/sqllogic.test.ts`) records this failure as `quereus/fix-alter-add-column-not-null-backfill-enforcement` (this ticket).

## Why the prior ticket didn't cover it

`1-fix-alter-add-column-constraint-enforcement` (complete, May 7) implemented:
- Signed-numeric DEFAULT acceptance + backfill (`tryFoldLiteral`).
- Column-level CHECK extraction + backfill validation (`validateBackfillAgainstChecks`).
- Column-level REFERENCES extraction + child-side FK check.

The backfill-validation pattern (`select 1 from <table> where not (<check>) limit 1`) is exactly what's needed for NOT NULL too — the predicate is just `<newcol> is not null`. But NOT NULL is structurally different from CHECK in Quereus (it's a column-schema flag, not a CHECK constraint), so the prior ticket's CHECK loop didn't pick it up.

## Scope

Add backfill validation for ADD COLUMN NOT NULL **when no DEFAULT is supplied** (or when the DEFAULT is NULL). The DEFAULT-with-non-NULL case is already handled — the DEFAULT backfills every row, so NOT NULL is satisfied by construction. The DEFAULT-with-NULL or no-DEFAULT case must reject if `<table>` is non-empty.

Empty-table case (`t_notnull_empty` at line 156 of the corpus) must still succeed — NOT NULL without DEFAULT against an empty table is fine because there are no rows to backfill.

### Algorithm

In `runAddColumn` in `packages/quereus/src/runtime/emit/alter-table.ts`:

1. Inspect the `ColumnDef` AST. If the column has `not null` set AND no DEFAULT (or DEFAULT is the NULL literal), continue with the check; otherwise skip.
2. Before applying the alter, query the table: `select 1 from <table> limit 1`. If empty, no backfill issue; proceed.
3. If non-empty, throw `QuereusError(StatusCode.CONSTRAINT, 'NOT NULL constraint failed: <table>.<newcol> — column added without a DEFAULT cannot satisfy NOT NULL on existing rows')`. The error must contain `NOT NULL` to match the corpus assertion.
4. The alter aborts atomically — no need to compensate-drop because the alter hasn't been applied yet (do the empty-check first).

Mirror the existing CHECK-backfill compensating-drop pattern only if the structure of `runAddColumn` requires the alter to apply first; otherwise simpler is better.

## Design constraints

- **Reuse existing patterns** — `validateBackfillAgainstChecks` already runs a `select 1 ... limit 1` via `db.prepare(...)._iterateRowsRaw()`. Use the same plumbing for the empty-check.
- **Empty-table case must still succeed** — corpus line 156 (`t_notnull_empty`) is the regression guard.
- **DEFAULT-with-value must still succeed** — corpus line 142 (`add column required text not null default 'default_val'`) currently passes.
- **Error message must contain `NOT NULL`** — the corpus assertion at line 132 (`-- error: NOT NULL`) is case-insensitive substring match. The current behavior (no error at all) is what's wrong.
- **No `default_column_nullability` dependency** — the corpus assertion is already explicit (`not null` declared); no implicit-nullability path is involved in this case.

## Tests

- `41-alter-table.sqllogic:131` now passes its `-- error: NOT NULL` assertion.
- `41-alter-table.sqllogic:142` (NOT NULL WITH DEFAULT) still succeeds.
- `41-alter-table.sqllogic:148` (NULL on non-empty table) still succeeds.
- `41-alter-table.sqllogic:156` (NOT NULL without DEFAULT on **empty** table) still succeeds.
- Add a dedicated test case if the corpus doesn't already cover: NOT NULL with DEFAULT NULL on non-empty table → fail.

## Verification

- `yarn workspace @quereus/quereus test --grep "41-alter-table"` — passes.
- `yarn workspace @quereus/quereus test` — no regressions.
- Downstream: `yarn vitest run packages/lamina-quereus-test/src/sqllogic/sqllogic.test.ts -t "41-alter-table.sqllogic"` in the lamina repo should pass *outside* `KNOWN_FAILURES` once this lands.

## Downstream

`lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` currently lists `41-alter-table.sqllogic` under `ALTER_ADD_COLUMN_NOT_NULL_BACKFILL` with `ticket: 'quereus/fix-alter-add-column-not-null-backfill-enforcement'`. When this fix lands, the lamina entry can be retired.
