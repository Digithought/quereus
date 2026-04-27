description: StoreTable now coerces incoming row values to declared column logical types on INSERT/UPDATE, mirroring the memory path (INTEGER/REAL affinity + JSON normalization). Idempotency hazard around JSON scalar strings via the isolation overlay→underlying flush addressed by a `preCoerced` bypass.
prereq: none
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/src/vtab/table.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus-store/test/column-coercion.spec.ts (new)
----

## Changes

- **`StoreTable.coerceRow`** (`packages/quereus-store/src/common/store-table.ts`): new protected helper that maps each incoming cell through `validateAndParse(value, column.logicalType, column.name)` — same helper the memory path already uses in `MemoryTableManager.performInsert/performUpdate`. Guards against `row.length > columns.length`.
- `StoreTable.update()` `insert` and `update` cases call `coerceRow` *before* `extractPK`, `buildDataKey`, `serializeRow`, `updateSecondaryIndexes`, and event emission so the coerced row is the single source of truth downstream. `delete` is untouched — it only needs `oldKeyValues` for the key lookup.
- **`UpdateArgs.preCoerced` flag** added in `packages/quereus/src/vtab/table.ts`. The isolation layer's overlay→underlying flush (`IsolatedTable.flushOverlayToUnderlying`) now passes `preCoerced: true`. `StoreTable.update` skips `coerceRow` when this flag is set. Required because the memory overlay has already coerced via `validateAndParse`, and JSON scalar strings are not idempotent under `JSON_TYPE.parse` (e.g. INSERT `'"hello"'` → overlay stores `"hello"` → flushing naïvely would call `JSON.parse("hello")` and throw).
- **`MEMORY_ONLY_FILES`** in `packages/quereus/test/logic.spec.ts`: removed `10-distinct_datatypes.sqllogic` and `06-builtin_functions.sqllogic` — both now pass in store mode with coercion enabled.

## Test coverage

- `packages/quereus-store/test/column-coercion.spec.ts` (new) exercises StoreModule directly (no isolation layer):
  - INTEGER affinity: `'100'` → `100` on INSERT; non-numeric string rejected; UPDATE path coerces.
  - REAL affinity: `'2.71'` → `2.71`.
  - TEXT affinity: `42` → `'42'`.
  - PK coercion: `INSERT '1'` into INTEGER PK, then `WHERE pk = 1` finds it.
  - JSON: parses `'{"a":1}'` into native object; `typeof` reports `'json'`; invalid JSON rejected.
  - Persistence round-trip: INTEGER and JSON columns survive close/reopen as native types (not raw text).
- `03.6-type-system.sqllogic` (`select j from json_tbl`, `typeof(j)`) and `97-json-function-edge-cases.sqllogic` now pass in store mode.
- `10.2-column-features.sqllogic:269` affinity check green under store.

## Verification

- `yarn workspace @quereus/quereus test` — 2443 passing, 0 failing.
- `yarn workspace @quereus/store test` — 207 passing (includes new `column-coercion.spec.ts`).
- `yarn test:store` — 566 passing, 1 failing (`50-declarative-schema.sqllogic` "Deferred constraint execution found multiple candidate connections" — pre-existing, unrelated; reproduced on clean `main` via `git stash`).
- `yarn workspace @quereus/quereus lint` — 0 errors (275 pre-existing `no-explicit-any` warnings, none new).

## Review focus

- Correctness of the `preCoerced` bypass mechanism. Is routing through UpdateArgs the right shape, or is an alternate API (e.g. a separate `updateFromOverlay` method on `StoreTable`) cleaner?
- Whether the memory overlay should instead NOT coerce (so the underlying coerces exactly once for both memory- and store-backed paths). Current choice: keep the memory overlay's coercion (unchanged) and let the store underlying skip re-coercion via flag.
- Ensure `UpdateResult.row` / `replacedRow` returning the coerced row doesn't leak into a call site that expected the raw values (callers: `emit/insert.ts`, upsert flows). Spot-check suggests they treat `row` as opaque logical rows, which is exactly the desired normalized form.
