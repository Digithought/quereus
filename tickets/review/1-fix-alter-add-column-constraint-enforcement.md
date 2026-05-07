description: ALTER TABLE ADD COLUMN — enforce column-level CHECK / REFERENCES, validate backfill, accept signed-numeric DEFAULT
prereq:
files:
  packages/quereus/src/parser/utils.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic
  packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
  packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic
----

## Summary

`alter table … add column` previously dropped column-level CHECK / REFERENCES from the resulting schema and rejected anything other than a bare literal as a DEFAULT (so `default -123.0` failed). It also did not validate that backfilled rows satisfy any new CHECK. All three are fixed.

## Behavior

Now legal / enforced:

```sql
-- Signed / parenthesised numeric DEFAULT backfills the literal value
alter table t add column r real default -123.0;

-- Column-level CHECK gets attached to the table; later inserts honor it
alter table t_chk add column b integer null check (b is null or b > 0);
insert into t_chk values (3, 30, -1); -- error: CHECK

-- Bare REFERENCES on ADD COLUMN now actually enforces child-side
alter table t_child add column parent integer null references t_parent(pid);
insert into t_child values (3, 'z', 99); -- error: FK violation

-- Backfill is validated against new CHECK; ALTER fails atomically if it would violate
create table t_bf (id integer primary key, a integer not null);
insert into t_bf values (1, 5), (2, 0);
alter table t_bf add column d integer not null default 0 check (d <> 0);
-- error; t_bf is unchanged after the failed ALTER
```

## Implementation

- `packages/quereus/src/parser/utils.ts` — new `tryFoldLiteral(expr)` recognises a `LiteralExpr` or a `UnaryExpr('+'|'-', literal)` (numeric/bigint inner value) and returns the SqlValue. Used to reach a constant default without invoking the planner.
- `packages/quereus/src/vtab/memory/layer/manager.ts` — `MemoryTableManager.addColumn` and the SET-NOT-NULL backfill path call `tryFoldLiteral` instead of testing `expr.type === 'literal'`, so signed-numeric defaults backfill correctly.
- `packages/quereus/src/runtime/emit/alter-table.ts::runAddColumn`:
  - Extracts column-level CHECK constraints (`extractColumnLevelCheckConstraints`) and FOREIGN KEY constraints (`extractColumnLevelForeignKeys`) from the `ColumnDef` AST.
  - Calls `module.alterTable({ type: 'addColumn' })`, then resolves the new column's index in the freshly returned schema and rebinds the FK's `columns` array.
  - Merges the new constraints into `tableSchema.checkConstraints` / `tableSchema.foreignKeys` and registers the *enhanced* schema in the catalog so subsequent SQL can resolve the new column.
  - When at least one new CHECK was added, runs `validateBackfillAgainstChecks` which executes `select 1 from <table> where not (<check_expr>) limit 1` for each new CHECK via `db.prepare(...) + _iterateRowsRaw()` (we are already inside the execution mutex; this mirrors `database-assertions.ts:executeViolationOnce`). On violation it issues a compensating `module.alterTable({ type: 'dropColumn' })`, restores the original `tableSchema` in the catalog, and rethrows a `CONSTRAINT` error so the table is unchanged.
  - Bare `references parent(col)` on ADD COLUMN now defaults `onDelete` and `onUpdate` to `restrict` (not `ignore`), because `buildChildSideFKChecks` skips FKs whose actions are both `ignore`. CREATE TABLE bare-FK behaviour in `extractForeignKeys` (schema/manager.ts) is intentionally left at `ignore` so `06.3.2-schema-foreign-keys.sqllogic` introspection results are unchanged.

## Use cases for testing / validation

- `packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic` — covers ADD COLUMN with CHECK (NULL backfill allowed; later CHECK violation rejected), with bare REFERENCES (child-side FK violation rejected), with `default -123.0` and `default 123.0` (negative + positive reals), and with `default 7` participating in `sum(...)` over backfilled rows.
- `packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic` — `alter table t_bf add column d integer not null default 0 check (d <> 0)` against rows where backfill = 0 fails, and `select * from t_bf` afterwards returns the original two rows unchanged.
- `packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic` — bare CREATE TABLE FKs still report `on_delete: ignore, on_update: ignore` (the ADD COLUMN default change is scoped to ADD COLUMN only).

## Acceptance status

- `yarn workspace @quereus/quereus test --grep "41.4"` — pass.
- `yarn workspace @quereus/quereus test --grep "90.2.1"` — pass.
- `yarn workspace @quereus/quereus test --grep "06.3.2"` — pass (introspection unchanged).
- `yarn workspace @quereus/quereus test` — 2522 passing, 3 pending, 0 failing.

## Notes for review

- The CHECK-revert path issues `module.alterTable({ type: 'dropColumn' })` to undo the just-added column. Worth spot-checking that the table is byte-identical after a CHECK-violating backfill (rows, columns, schema all restored).
- FK backfill validation is not yet performed. The ticket-scope test backfills NULL (always satisfies MATCH SIMPLE). A future "non-NULL default + FK on new column" case would not re-check existing rows; INSERT/UPDATE enforcement still kicks in for new rows. Out of scope here.
- ADD COLUMN bare-FK now defaults to `restrict` while CREATE TABLE bare-FK still defaults to `ignore`. This is intentional for now (it is what makes child-side enforcement actually fire on ADD COLUMN); aligning the two paths is a separate ticket.

## TODO

- [ ] Reviewer: re-run `yarn workspace @quereus/quereus test --grep "41.4"`, `--grep "90.2.1"`, and `--grep "06.3.2"` and confirm all three pass.
- [ ] Reviewer: spot-check `runAddColumn` revert logic in `packages/quereus/src/runtime/emit/alter-table.ts:229-245` — confirm that on a CHECK-violating backfill the catalog and `MemoryTableModule.tables` entry both end up in their pre-ALTER state (no orphan column, no stray index, no leaked FK).
- [ ] Reviewer: confirm `extractColumnLevelForeignKeys` correctly resolves the new child column index after `module.alterTable` returns (the FK's `columns` is re-bound from the empty placeholder to `[newColIdx]`).
- [ ] Reviewer: sanity-check `tryFoldLiteral` only folds `±literal` where the inner is `number | bigint` (not strings, not nested unaries beyond ± of literal).
