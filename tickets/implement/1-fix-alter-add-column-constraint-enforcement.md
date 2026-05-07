description: ALTER TABLE ADD COLUMN — enforce column-level CHECK / REFERENCES, validate backfill, accept signed-numeric DEFAULT
prereq:
files:
  packages/quereus/src/parser/utils.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic
  packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
----

## Summary

Implementation already landed. The ADD COLUMN path now:

1. Accepts signed-numeric / parenthesised numeric DEFAULTs by folding `unary(+|-, literal)` to a SqlValue at backfill time.
2. Wires column-level CHECK constraints into `tableSchema.checkConstraints` so `buildConstraintChecks` enforces them on subsequent INSERT/UPDATE.
3. Wires column-level FOREIGN KEY constraints into `tableSchema.foreignKeys` so `buildChildSideFKChecks` enforces MATCH SIMPLE child-side checks on INSERT/UPDATE (defaults `ON DELETE/UPDATE` to `restrict` because Quereus's child-side FK builder skips FKs whose actions are both `ignore`).
4. Validates the backfill default against any new CHECK constraint by running `select 1 from <table> where not (<check_expr>) limit 1` against the freshly added column. On violation the column is dropped and the original schema restored before throwing — so the table is unchanged after the failed ALTER.

## Key files

- `packages/quereus/src/parser/utils.ts` — new `tryFoldLiteral(expr)` helper that handles `LiteralExpr` and `UnaryExpr(±, literal)`.
- `packages/quereus/src/vtab/memory/layer/manager.ts` — `MemoryTableManager.addColumn` and the SET-NOT-NULL backfill path use `tryFoldLiteral` instead of raw `expr.type === 'literal'` so negative-literal defaults backfill correctly.
- `packages/quereus/src/runtime/emit/alter-table.ts` — `runAddColumn` extracts column-level CHECK / FK from the ColumnDef AST, merges them into the returned schema, registers the enhanced schema in the catalog, and runs SQL-driven backfill validation with explicit revert (drop column + restore catalog) on failure.

## Use cases / validation

- `packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic`: CHECK enforced on later inserts; bare REFERENCES enforced on later inserts; negative-literal DEFAULT backfills the literal value.
- `packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic`: ALTER TABLE ADD COLUMN with `not null default 0 check (d <> 0)` against rows where backfill = 0 fails; the table must be left unchanged.
- `yarn workspace @quereus/quereus test` — full suite passes (the only pre-existing failure is `18-json-string-escapes.sqllogic`, unrelated to this ticket).
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn build` — clean.

## Notes for review

- Bare `references parent(col)` (no `ON DELETE/UPDATE` clause) on ADD COLUMN now defaults to `restrict` so child-side enforcement actually runs. Bare FK in CREATE TABLE still defaults to `ignore` (preserved by `extractForeignKeys` in `schema/manager.ts`) and the existing introspection test `06.3.2-schema-foreign-keys.sqllogic` still depends on that. The two paths are intentionally inconsistent for now; aligning them is a separate ticket.
- The CHECK backfill validator runs SQL via `db.prepare(...) + _iterateRowsRaw()` which doesn't acquire the execution mutex (we're already inside it). This mirrors the pattern used by `database-assertions.ts:executeViolationOnce`.
- FK backfill validation is not yet performed (the ticket-scope test backfills NULL, which always satisfies MATCH SIMPLE). Any future "non-NULL default + FK on new column" case will fall through to insert/update enforcement on subsequent rows; existing rows aren't re-checked.

## TODO

- [ ] Reviewer: run `yarn workspace @quereus/quereus test --grep "41.4"` and `--grep "90.2.1"` and confirm both pass.
- [ ] Reviewer: spot-check `runAddColumn` revert logic — confirm the table is byte-identical (rows, columns, schema) after a CHECK-violating backfill.
- [ ] Reviewer: confirm `06.3.2-schema-foreign-keys.sqllogic` still reports `on_update: ignore, on_delete: ignore` for bare CREATE TABLE FKs (we only changed ADD COLUMN's default).
