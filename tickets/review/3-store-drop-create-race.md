description: Serialize DROP TABLE destruction before returning, eliminating the DROP/CREATE race against async store destruction
prereq: none
files:
  packages/quereus/src/schema/manager.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-plugin-leveldb/src/provider.ts
  docs/schema.md
  packages/quereus/test/logic/102-schema-catalog-edge-cases.sqllogic
  packages/quereus/test/logic/40-constraints.sqllogic
----

## Summary

Fire-and-forget `module.destroy(...)` from `SchemaManager.dropTable` raced with a subsequent `CREATE TABLE` of the same name, because `StoreModule.destroy` yields on `await table.disconnect()` and `await provider.deleteTableStores(...)`. During those yields, a follow-up CREATE could observe the still-mapped old `LevelDBStore`, bind a new `StoreTable` to it, and then have its store closed and directory wiped when the in-flight destroy resumed. The next INSERT hit "LevelDBStore is closed".

## Fix

Primary change — `packages/quereus/src/schema/manager.ts:430`:
- `dropTable` is now `async` and returns `Promise<boolean>`.
- It `await`s the `destroyPromise` before returning, so any subsequent DDL/DML sees fully torn-down storage.
- Sole caller (`packages/quereus/src/runtime/emit/drop-table.ts:24`) already `await`s — no further wiring needed.

Defence in depth — narrows the race window even for future callers:
- `LevelDBProvider.closeStoreByName` (`packages/quereus-plugin-leveldb/src/provider.ts:231`): `stores`/`storePaths` map entries are deleted **before** `await store.close()`, so a concurrent `getOrCreateStore` cannot return a handle that is about to be closed.
- `StoreModule.destroy` (`packages/quereus-store/src/common/store-module.ts:264`): `tables`, `stores`, and `coordinators` map entries are cleared synchronously at the top of the method, before any `await`. Concurrent `create(...)` now sees "no such table" across microtask boundaries instead of stale state.

Docs (`docs/schema.md`) updated to reflect the new async signature and ordering.

## Out of scope

The sibling `ALTER TABLE ... RENAME TO ...` StoreModule bug (41-alter-table.sqllogic:104 still fails under `yarn test:store`) is unrelated to this race and belongs to its own ticket — `runRenameTable` in `packages/quereus/src/runtime/emit/alter-table.ts:83-87` only updates MemoryTableModule state and never tells StoreModule about the rename.

## Validation

- `yarn build` — green.
- `yarn test` — all 59 + 34 + 121 tests pass across packages.
- `yarn test:store` — 566 passing, 19 pending, 1 failing (`50-declarative-schema.sqllogic:274` — pre-existing, reproduced on base commit before any of these changes, unrelated to DROP/CREATE).
- The regressions mentioned in the ticket (`40-constraints.sqllogic`, `102-schema-catalog-edge-cases.sqllogic`) both pass under store mode.

## Use cases to exercise during review

- `DROP TABLE t; CREATE TABLE t (...); INSERT INTO t ...;` against a store-backed table — must not see "LevelDBStore is closed".
- `DROP TABLE IF EXISTS t` on a missing table — must still return `false` via the promise and not throw.
- Back-to-back `CREATE TABLE t / DROP TABLE t / CREATE TABLE t` — storage directory must be recreated cleanly; no stale LevelDB file locks.
- Error paths inside `module.destroy` — errors are still caught-and-logged (the `.catch` on `destroyPromise` is preserved), so a failing destroy does not prevent the schema removal event from firing, but `dropTable` now resolves only after destroy has settled.

## Review checklist

- `dropTable` signature is the only public-API change; confirm no callers were missed.
- Map-clear-before-await ordering in `StoreModule.destroy` is correct even on the error path (a thrown `table.disconnect()` still leaves maps clean — verify this is intended).
- `closeStoreByName` reorder in LevelDBProvider is safe — the store handle is captured in a local before the delete, so the subsequent `await store.close()` still targets the right instance.
