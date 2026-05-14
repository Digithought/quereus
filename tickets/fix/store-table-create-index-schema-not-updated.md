---
description: After `CREATE INDEX` on a `USING store` table, the StoreTable's cached `tableSchema.indexes` is not refreshed, so subsequent INSERT/UPDATE/DELETE never call `updateSecondaryIndexes` for the new index. Index entries built by `buildIndexEntries` at CREATE-time become permanently stale once any row is touched.
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## Repro

Insert into a store-backed table after CREATE INDEX, then inspect the index store directly via `KVStoreProvider.getIndexStore`:

```ts
db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
db.exec(`INSERT INTO t VALUES (1, 100)`);
db.exec(`CREATE INDEX t_b ON t (b)`);   // index store now has 1 entry
db.exec(`INSERT INTO t VALUES (2, 200)`); // expected: 2 entries; actual: 1
db.exec(`UPDATE t SET b = 999 WHERE id = 1`); // expected: (b=999, id=1) + (b=200, id=2); actual: still just (b=100, id=1)
```

Diagnostic in `ensureIndexStore` shows it is never called for the post-CREATE index — i.e. `updateSecondaryIndexes` is iterating an empty `tableSchema.indexes` list because the StoreTable instance still holds the schema captured at table-connect time.

## Likely cause

`StoreModule.createIndex` (packages/quereus-store/src/common/store-module.ts:308) builds initial entries via `buildIndexEntries`, but does not refresh the `StoreTable` instance's `tableSchema` to include the new index. The schema-manager-side `Schema.addTable(updated)` may happen for ALTER paths but isn't replayed onto already-connected StoreTable instances.

## Impact

- All secondary INDEX maintenance is broken on `USING store` tables for any index created after the table has rows or after any subsequent writes.
- Currently masked because `StoreModule.query()` does not consult secondary indexes (see comment at store-module.ts:826) — so query results are still correct via full scans. When index-driven access is wired up, this bug will produce wrong results.
- Also masks bugs in PK-change UPDATE's secondary-index handling (the helper uses the wrong PK suffix when removing the moved row's old index entry — see related ticket `store-table-pk-change-update-leaks-moved-row-index`).

## Suggested approach

- After `createIndex` builds entries, refresh the connected StoreTable's `tableSchema` to include the new `TableIndexSchema` (or invalidate / reconnect the table).
- Add a regression test in `packages/quereus-store/test/column-default-conflict.spec.ts` that asserts the index store has entries for rows inserted *after* the CREATE INDEX statement (the current `column-default-conflict.spec.ts` reviewer notes describe what was tried and failed).

## Discovery context

Found while reviewing `tickets/review/store-table-update-column-default-conflict.md`. The reviewer wrote a test that inspected the index store directly to verify eviction-cleanup, and found pre-existing entries from `buildIndexEntries` plus zero new entries from any subsequent write — making it impossible to validate the eviction fix at the index-store level.
