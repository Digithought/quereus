description: Code review for ADD COLUMN NOT NULL backfill rejection. `runAddColumn` now pre-checks for `NOT NULL` without a usable DEFAULT (no DEFAULT, DEFAULT NULL, or DEFAULT with no expression) and queries the table; if any row exists the alter aborts with a CONSTRAINT error before any schema or module state is touched. Empty-table and DEFAULT-with-non-NULL paths remain unchanged.
files:
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41-alter-table.sqllogic
----

## What changed

`packages/quereus/src/runtime/emit/alter-table.ts`:
- After the foldable-DEFAULT validation and module-supports-alterTable check, `runAddColumn` now classifies the new column:
  - `hasNotNull` from `columnDef.constraints` containing `{ type: 'notNull' }`.
  - `defaultIsNullish` covers all three nullish cases via `tryFoldLiteral`: no `defaultConstraint`, `defaultConstraint` with no `.expr`, or folded value is `null`. Non-foldable DEFAULTs are already rejected earlier so `tryFoldLiteral` returning `undefined` here implies no expression.
  - When both flags hold, calls the new `validateNotNullBackfill`.
- New helper `validateNotNullBackfill` mirrors `validateBackfillAgainstChecks`'s plumbing (qualified table, schema prefix only when not `main`, `db.prepare`/`_iterateRowsRaw`/`finalize`). It runs `select 1 from <qualifiedTable> limit 1`; if any row materializes, throws `QuereusError(CONSTRAINT, "NOT NULL constraint failed for column '<col>' added to <schema>.<table> — column has no DEFAULT and existing rows cannot be backfilled")`.

The error message is engineered to satisfy three case-insensitive substring assertions in the corpus (lines 132, 136, 139): `NOT NULL`, `'rank'`, `main.t_notnull`.

## Why pre-mutation

The CHECK path uses post-mutation validation because the predicate references the new column; here the empty-check is column-agnostic, so doing it before any schema/module change avoids the compensating-drop pattern entirely. If the alter aborts, neither the module's storage nor the catalog has been touched.

## Verification done in implement

- `yarn workspace @quereus/quereus test --grep "41-alter-table"` — passing.
- `yarn workspace @quereus/quereus test` — 2705 passing, 2 pending, no regressions.

## Review checklist

- Confirm pre-mutation ordering is correct — no schema state has been mutated by the time the helper throws (module.alterTable is the first state-mutating call and it's still ahead).
- Confirm `tryFoldLiteral` returning `null` (literal NULL) vs `undefined` (no expression / unfoldable) is the right discriminator for "nullish DEFAULT". Non-foldable DEFAULT is rejected earlier in this function, so the only way `tryFoldLiteral` returns `undefined` at this point is `defaultConstraint.expr` being absent — which the `defaultConstraint?.expr ? ... : undefined` guard handles explicitly.
- Confirm error wording is acceptable; the three corpus assertions are case-insensitive substrings on `NOT NULL`, `'rank'`, and `main.t_notnull`.
- Confirm the helper's `select 1 ... limit 1` against an empty table closes cleanly without leaking the prepared statement (the `try/finally` around `stmt.finalize()` mirrors `validateBackfillAgainstChecks`).
- Confirm no DRY duplication worth extracting between `validateNotNullBackfill` and `validateBackfillAgainstChecks` — the schema-prefix computation and prepare/iterate/finalize block are nearly identical. A shared helper `prepareTableRowProbe(rctx, tableSchema, whereSql?)` could collapse both, but the CHECK loop iterates over multiple constraints with named errors per constraint and the NOT NULL path is one-shot — extracting a probe helper is a small win against a small surface. Reviewer's call.

## Downstream

`lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` lists `41-alter-table.sqllogic` under `ALTER_ADD_COLUMN_NOT_NULL_BACKFILL` with `ticket: 'quereus/fix-alter-add-column-not-null-backfill-enforcement'`. With this landed, the lamina KNOWN_FAILURES entry can be retired.
