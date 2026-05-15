---
description: Review StoreModule.dropIndex — refreshes connected StoreTable's cached tableSchema (strips index + derivedFromIndex UNIQUE constraint), closes the cached index-store handle, tears down the KVStore via provider.deleteIndexStore ?? closeIndexStore, and emits a 'drop'/'index' schemaChange event. Mirrors StoreModule.createIndex and MemoryTableManager.dropIndex.
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## Summary

Before this change `StoreModule` had no `dropIndex` implementation, so
`SchemaManager.dropIndex` (`packages/quereus/src/schema/manager.ts:1304`)
fell through to "no module hook" and only refreshed the engine-side
`TableSchema`. The connected `StoreTable` kept its constructor-captured
schema, so:

- subsequent INSERT/UPDATE/DELETE on a `USING store` table still
  maintained entries in the dropped index store (via
  `StoreTable.updateSecondaryIndexes`), and
- for UNIQUE indexes, the synthesized `UniqueConstraintSchema` (tagged
  `derivedFromIndex` by `StoreModule.createIndex`) kept enforcing
  uniqueness from `StoreTable.checkUniqueConstraints`.

The `drop-unique-index.sqllogic` engine test exercised all three cases
(basic, coincident-name, partial-UNIQUE) and passed under the memory
module but failed under the store module. After this change it passes
under both.

## Implementation

### `StoreTable.releaseIndexStore(indexName)`
(`packages/quereus-store/src/common/store-table.ts:186-192`)

Public method that drops the cached entry from the protected
`indexStores` map and closes the underlying handle. Close failures are
swallowed (best-effort, mirrors `renameTable`'s `disconnect()` block).

### `StoreModule.dropIndex(_db, schemaName, tableName, indexName)`
(`packages/quereus-store/src/common/store-module.ts:370-431`,
inserted immediately after `createIndex`)

1. Resolve the table from `this.tables`; throw NOTFOUND if absent.
2. Compute the updated schema: filter `indexes` by lowercase name,
   filter `uniqueConstraints` by `derivedFromIndex?.toLowerCase()`,
   collapse `uniqueConstraints` to `undefined` when empty (matches
   `SchemaManager.dropIndex`).
3. Call `table.updateSchema(updatedSchema)` **BEFORE** the physical
   teardown — if `deleteIndexStore` throws, the cached schema has
   already lost the index so a subsequent DML doesn't keep poking the
   half-deleted store.
4. `table.releaseIndexStore(indexName)` — drop and close the
   `StoreTable.indexStores` slot so the next access reopens fresh.
5. `provider.deleteIndexStore ?? closeIndexStore` — tear down the
   physical store (LevelDB unlinks the directory; the in-memory fixture
   evicts its cache entry; providers that don't supply
   `deleteIndexStore` get the no-op `closeIndexStore` fallback).
6. Emit `schemaChange { type: 'drop', objectType: 'index', schemaName,
   objectName: indexName }`.

The engine-side schema registry update (`SchemaManager.dropIndex`
`packages/quereus/src/schema/manager.ts:1319-1331`) was already correct
and is unchanged; it runs after `module.dropIndex` resolves.

## Tests added

### `packages/quereus-store/test/column-default-conflict.spec.ts`

New describe block **"DROP INDEX refreshes cached tableSchema and
releases index store"** with three cases:

1. **drops the UNIQUE constraint synthesized by CREATE UNIQUE INDEX** —
   creates the table, indexes a column, confirms a duplicate INSERT is
   rejected, then DROPs the index and confirms the same duplicate now
   succeeds.
2. **stops maintaining the dropped non-UNIQUE index store on subsequent
   inserts** — creates a non-UNIQUE index, inserts one row, verifies the
   index store has one entry, DROPs the index, inserts a fresh row, and
   asserts the (now fresh) index store is empty.
3. **emits a schemaChange event with type=drop, objectType=index** —
   constructs a `StoreEventEmitter`, registers a listener, runs DROP
   INDEX, asserts exactly one matching event.

### Test fixture change

`createInMemoryProvider` previously had no-op `closeIndexStore` and no
`deleteIndexStore`. To keep case 2's "fresh getIndexStore is empty"
assertion clean, both now evict the cached entry from the fixture's
`stores` map — matching how the LevelDB provider's `closeIndexStore` /
`deleteIndexStore` drop their cache (`packages/quereus-plugin-leveldb/src/provider.ts:95-123`).
This is purely a test-fixture refinement; the production fix code
handles the no-`deleteIndexStore` provider path via the
`closeIndexStore` fallback.

## Validation run

- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/store test` — 269 passing (was 266 before;
  +3 new cases, all green).
- `yarn workspace @quereus/quereus test` — 2942 passing, 2 pending. The
  `drop-unique-index.sqllogic` test passes against memory.
- `yarn workspace @quereus/quereus test:store` — `drop-unique-index.sqllogic`
  now passes against the store module. One **pre-existing** failure
  remains in `29.1-column-level-conflict-clause.sqllogic:144` (UPDATE
  PK-change-REPLACE FK ON DELETE CASCADE under LevelDB) — unrelated to
  this work, and the matching store-package unit test
  ("CASCADE deletes children of the evicted row",
  `column-default-conflict.spec.ts:317-346`) using the in-memory KV
  provider still passes. Flagging it here so the reviewer doesn't think
  this change introduced it.

## Reviewer checklist

- Confirm `table.updateSchema(...)` runs BEFORE
  `releaseIndexStore`/`deleteIndexStore`. The ordering is load-bearing:
  on a teardown failure, the cached schema must already have lost the
  index so subsequent DML doesn't try to write into a half-deleted
  store.
- Confirm the `derivedFromIndex` filter on the drop side mirrors
  `SchemaManager.dropIndex:1322-1324` and
  `MemoryTableManager.dropIndex:1348-1356` — same lowercase comparison,
  same collapse-to-undefined-when-empty rule.
- Sanity-check that a future `connect()` against this table will pull
  the engine-side schema (where the index is also gone, see
  `StoreModule.connect:223-225`), so the cached and registered schemas
  stay in sync across reconnects.
- The `releaseIndexStore` body swallows `close()` failures — this is
  intentional (close is best-effort) but the reviewer should sanity-check
  that no in-flight write batch depends on the handle staying open.
  None of the StoreTable.update paths buffer through the index-store
  handle directly: the data coordinator's `delete`/`put(indexStore=…)`
  takes a reference at queue time, so a close after `dropIndex` returns
  cannot interleave with in-flight DML on this table.

## Known gaps / things to look at

- Concurrency: `StoreModule.dropIndex` is not latched against a
  concurrent INSERT/UPDATE on the same table. `MemoryTableManager.dropIndex`
  uses a `Latches.acquire` lock; the store side does not. If a reviewer
  thinks this matters for the store module, file as a follow-up — out of
  scope for this ticket which mirrors `createIndex`'s level of locking
  (also unlatched).
- The pre-existing `29.1-column-level-conflict-clause.sqllogic:144`
  failure under `yarn test:store` is unrelated and should get its own
  ticket if not already filed.
