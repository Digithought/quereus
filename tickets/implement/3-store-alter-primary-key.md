description: Implement native ALTER PRIMARY KEY in the store module by re-keying the data store and rebuilding secondary indexes.
dependencies: none
files:
  packages/quereus-store/src/common/store-module.ts        (replace UNSUPPORTED throw with implementation)
  packages/quereus-store/src/common/store-table.ts         (add a `rekeyRows` helper alongside existing `migrateRows`/`mapRowsAtIndex`)
  packages/quereus-store/src/common/key-builder.ts         (existing: `buildDataKey`, `buildIndexKey`, `buildFullScanBounds`)
  packages/quereus-store/src/common/serialization.ts       (existing: `serializeRow`/`deserializeRow`)
  packages/quereus-store/test/alter-table.spec.ts          (extend with ALTER PK coverage)
  packages/quereus/src/runtime/emit/alter-table.ts         (no change — already routes `alterPrimaryKey` through `module.alterTable` first)
  packages/quereus/test/logic/41.1-alter-pk.sqllogic       (must pass under `QUEREUS_TEST_STORE=true`)
  packages/quereus/test/logic/50.1-declare-schema-pk.sqllogic (must pass under `QUEREUS_TEST_STORE=true`)
  packages/quereus/src/vtab/module.ts                      (reference: `SchemaChangeInfo.alterPrimaryKey` carries `newPkColumns: ReadonlyArray<{ index: number; desc: boolean }>` — column indices are unchanged from old schema)
----

## Background

`StoreModule.alterTable` switches over `SchemaChangeInfo.type`. Today the `alterPrimaryKey` arm throws `QuereusError(StatusCode.UNSUPPORTED)` at `store-module.ts:539-543`. The runtime emitter (`runAlterPrimaryKey` in `packages/quereus/src/runtime/emit/alter-table.ts:322-391`) does *try* a shadow-table rebuild fallback when the module returns `UNSUPPORTED`, but the fallback is unreliable and the ticket calls for a native re-key (cleaner, faster, and doesn't depend on `_execWithinTransaction` driving DROP/RENAME through the store).

> Note for the implementer: there is an incidental bug here that the runtime fallback's `e instanceof QuereusError` check can fail under the test harness when the engine source runs through ts-node while the store dist imports the compiled engine — two distinct `QuereusError` classes. Implementing the native path makes the issue moot for these tickets, but you may want to flag a follow-up to harden the catch to `e?.code === StatusCode.UNSUPPORTED`.

## Semantics

`change.newPkColumns` is `{ index, desc }[]` referencing existing column positions in `oldSchema.columns`. Column layout is unchanged — only the PK definition is replaced. The runtime layer (`runAlterPrimaryKey`) has already validated:
- every PK column is `NOT NULL`
- no duplicate column indices
- all column names exist

So the store module can trust the input shape. It still must enforce **uniqueness** of the resulting keys (the actual data may collide under the new PK) and surface that as `StatusCode.CONSTRAINT` *without* mutating any store.

## Approach

1. **Build the new schema** — clone `oldSchema` with `primaryKeyDefinition: Object.freeze(change.newPkColumns.map(...))`. Column array, indexes, etc. unchanged.

2. **Re-key the data store** in two passes:
   - Pass 1 (read + validate): stream every row, compute the new PK bytes via `buildDataKey(newPkValues, encodeOptions)`. Track `Map<string, { newKey: Uint8Array; oldKey: Uint8Array; row: Row }>` keyed by a string view of `newKey` (e.g. `Buffer.from(newKey).toString('binary')` or `Array.from(newKey).join(',')`). On collision, throw `QuereusError(..., StatusCode.CONSTRAINT)` with a clear "duplicate primary key on rekey" message — store untouched.
   - Pass 2 (write): a single `store.batch()` that deletes every old key whose new key differs, then puts every (newKey, serializedRow) pair. The `oldKey === newKey` case is a no-op.

3. **Rebuild secondary indexes** — every secondary-index key embeds the PK suffix (`buildIndexKey(indexValues, pkValues, ...)` in `key-builder.ts:86-94`). After re-keying:
   - For each index in `oldSchema.indexes ?? []`: open its index store, iterate and `batch.delete` every existing entry, then call the existing `buildIndexEntries` (or inline equivalent) against the now-rekeyed data store. Doing a *full clear + rebuild* keeps the logic trivially correct vs. trying to compute per-row diffs.
   - The clear pass needs a helper since `KVStore` has no truncate; iterate `store.iterate(buildFullScanBounds())` and `batch.delete(entry.key)`. (Fine in practice — index entries are small; we already accept O(n) for ALTER PK.)

4. **Persist + announce** — `table.updateSchema(updatedSchema)`, `await this.saveTableDDL(updatedSchema)`, emit the `alter` schema change event. Mirror exactly what `addColumn` / `dropColumn` already do at `store-module.ts:430-440`.

5. **Stats** — row count is preserved across re-key, so leave `cachedStats` alone.

## Transactional semantics

The existing `addColumn`/`dropColumn`/`renameColumn` paths in `StoreModule.alterTable` call `table.migrateRows(...)` / `table.mapRowsAtIndex(...)`, both of which write directly via `store.batch()` — they do **not** route through `TransactionCoordinator`. Match that convention for ALTER PK. The validation pass before any write is what gives us the all-or-nothing guarantee for the duplicate-key case (test 41.1 §3 expects "Table should be unchanged" after the failed rekey).

A real crash mid-batch leaves the store in an inconsistent state — same as for the existing ALTER paths. That's a broader concern (atomic schema migration on KV stores) and out of scope here.

## Helper placement

Add the re-key logic as `StoreTable.rekeyRows(newPkDef: ReadonlyArray<{ index: number; desc: boolean }>): Promise<void>` next to `migrateRows` (`store-table.ts:194-209`). Keep the `buildIndexEntries`-style index rebuild in the module (it already lives there at `store-module.ts:340-367`) and call it from the alterTable case after the data re-key — rather than duplicating it on the table.

The table method handles only the data store. The module orchestrates: validate input → call `table.rekeyRows(...)` → for each index, clear + rebuild via the data store → swap schema.

## TODO

Phase 1 — Native re-key in the store module:
- Add `StoreTable.rekeyRows(newPkDef)` in `packages/quereus-store/src/common/store-table.ts`. Two-pass (validate then batch). Throw `CONSTRAINT` on duplicates before touching the store.
- In `StoreModule.alterTable`'s `case 'alterPrimaryKey'` (replace the throw at `store-module.ts:539-543`):
  - Build `updatedSchema` with new `primaryKeyDefinition`.
  - `await table.rekeyRows(change.newPkColumns)`.
  - For each index in `oldSchema.indexes ?? []`: open index store, iterate + batch-delete existing entries, then call `this.buildIndexEntries(dataStore, indexStore, updatedSchema, indexSchema)` to repopulate.
  - `table.updateSchema(updatedSchema)`, `await this.saveTableDDL(updatedSchema)`, emit `alter` schema change event.
  - `return updatedSchema`.

Phase 2 — Tests:
- Extend `packages/quereus-store/test/alter-table.spec.ts` with ALTER PK cases:
  - Empty table re-key (PK swap on zero rows).
  - Populated table re-key, validate row count and contents readable under new PK (do a point lookup via `select … where new_pk = …`).
  - Duplicate-on-rekey: insert rows that collide under the new PK, expect `CONSTRAINT`, then verify the table is unchanged (still queryable under old PK, same row count).
  - With a secondary index present: re-key, then verify the index is still usable (a query that should hit the index returns correct results).
- `yarn workspace @quereus/quereus-store test` must pass.

Phase 3 — Logic-test gating:
- `cd packages/quereus && node test-runner.mjs --store --grep "41.1"` — `41.1-alter-pk.sqllogic` must pass.
- `cd packages/quereus && node test-runner.mjs --store --grep "50.1"` — `50.1-declare-schema-pk.sqllogic` must pass.
- `yarn test` (memory mode) must still pass — the memory path is untouched but re-run as a guard.

Phase 4 — Optional follow-up (do not block this ticket, but call it out in the review hand-off):
- Harden `runAlterPrimaryKey`'s catch in `packages/quereus/src/runtime/emit/alter-table.ts:377-383` to compare on `e?.code === StatusCode.UNSUPPORTED` instead of `e instanceof QuereusError`, so the shadow-table fallback works even when the thrown error originated in a sibling-package dist with a distinct class instance. Without this, the fallback is invisibly broken in the test harness.
