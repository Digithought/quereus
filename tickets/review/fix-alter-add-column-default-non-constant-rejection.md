description: ALTER TABLE ADD COLUMN now rejects non-foldable DEFAULT expressions (column references, bind parameters, non-deterministic functions) at DDL time per the determinism rule. Symmetric scope extension on `1-fix-alter-add-column-constraint-enforcement` (complete).
files:
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/parser/utils.ts
  packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
----

## What changed

`runAddColumn` in `packages/quereus/src/runtime/emit/alter-table.ts` now validates the DEFAULT expression on the incoming `ColumnDef` against `tryFoldLiteral` (re-used from `packages/quereus/src/parser/utils.ts`). If the DEFAULT cannot fold to a literal, the ALTER is rejected at DDL time with:

> ALTER TABLE ADD COLUMN DEFAULT for '<col>' must fold to a literal — column references, bind parameters, and non-deterministic expressions are not allowed

This makes the rejection symmetric with CREATE TABLE's `validateDefaultDeterminism` (which already rejects bind parameters and bare column references in DEFAULT), and ensures behavior is independent of the `default_column_nullability` setting. Previously, the rejection only happened as a side-effect of the NOT-NULL backfill guard (`Cannot add NOT NULL column ... without a DEFAULT value`) — under `default_column_nullability = 'nullable'` (SQL-standard), non-foldable DEFAULTs silently slipped through with a warning-only NULL backfill.

## Why this exists

The prior ticket `1-fix-alter-add-column-constraint-enforcement` added `tryFoldLiteral` to accept signed-numeric DEFAULT literals (e.g. `default -123.0`) and added CHECK / FK backfill validation, but did not add a DDL-time rejection for non-foldable DEFAULTs. The downstream lamina-on-quereus harness (running with `default_column_nullability = 'nullable'`) flagged that ADD COLUMN with `default (a + 1)` succeeded silently. This ticket adds the missing rejection.

## Allowed DEFAULT shapes (unchanged)

- `default 5`, `default 'text'`, `default null`, `default true`, `default false`
- `default -123`, `default -123.0`, `default (123.0)`, `default (-(-123))`

All literal and signed-numeric DEFAULTs continue to work, including the parenthesized forms (parens don't produce their own AST node).

## Rejected DEFAULT shapes (new)

- Column references: `default (a)`, `default (a + 1)`, `default (concat(a, 'x'))`
- Bind parameters: `default (:foo)`, `default (?)` — previously rejected only by the NOT-NULL backfill side-effect; now rejected at DDL time regardless of nullability
- Function calls and non-deterministic expressions: `default (random())`, `default (current_timestamp)`, `default (1 + 2)` — anything `tryFoldLiteral` returns `undefined` for

## Validation

- `yarn workspace @quereus/quereus test --grep "90.2.1-alter-extra-errors"` — passes; the column-reference case at line 31 now errors with the new DDL-time message (previously errored only as a side-effect of NOT-NULL backfill).
- `yarn workspace @quereus/quereus test --grep "alter"` — 19 passing, no regressions.
- `yarn workspace @quereus/quereus test` — full suite: 2705 passing, 2 pending. No regressions.
- `yarn workspace @quereus/quereus run lint` — clean.

## Use cases / interfaces to review

- **`runAddColumn` (packages/quereus/src/runtime/emit/alter-table.ts:192-205)** — the new check runs immediately after the existing PK rejection, before the module's `alterTable` is invoked. Failures throw `QuereusError(StatusCode.ERROR, ...)` synchronously.
- **`tryFoldLiteral`** — re-used as the canonical "does this DEFAULT fold?" predicate. No changes required there.
- **CREATE TABLE path** — unchanged; its `validateDefaultDeterminism` is broader (allows deterministic function expressions over constants) because CREATE has no backfill requirement. ADD COLUMN intentionally uses the stricter `tryFoldLiteral` predicate because it must backfill existing rows with a concrete literal value.

## Tests to inspect

- `packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic:23-32` — both bind-param and column-ref DEFAULT cases now hit the new DDL-time error rather than the NOT-NULL backfill side-effect.
- `packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic` — all positive literal-DEFAULT cases (`default 7`, `default -123.0`, `default 123.0`) confirmed still passing.
- `packages/quereus/test/logic/41-alter-table.sqllogic`, `41.5-alter-misc.sqllogic`, `105-vtab-memory-mutation-kills.sqllogic` — string-literal DEFAULTs continue to work.

## Reviewer notes

- The error message text is intentionally specific so callers can diagnose; the sqllogic `-- error:` assertion is bare so it matches any error, but downstream consumers and human readers benefit from the specific wording.
- The `MemoryTableManager.addColumn` warning path at `packages/quereus/src/vtab/memory/layer/manager.ts:947` (`Default for new col is expr; existing rows get NULL`) is now unreachable for the ADD COLUMN entry point because the runtime emit layer rejects first. It is still reachable from internal callers / direct module use, so leaving it in place is safe — but a follow-up could prune it if no other entry point exercises it.
- Consider whether `ALTER COLUMN SET DEFAULT <non-foldable-expr>` deserves the same DDL-time rejection. It is out of scope for this ticket (no test coverage in the corpus), but symmetry argues for it. File separately if desired.
- Downstream: `lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` can retire the `ALTER_ADD_COLUMN_DEFAULT_NON_CONSTANT` entry pointing at `quereus/fix-alter-add-column-default-non-constant-rejection` once this lands.
