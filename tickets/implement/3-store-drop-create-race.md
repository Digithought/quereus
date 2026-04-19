description: Fire-and-forget VTab destroy from DROP TABLE races with a subsequent CREATE TABLE, causing the freshly opened LevelDBStore to be closed mid-operation
dependencies: none
files:
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/runtime/emit/drop-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-plugin-leveldb/src/provider.ts
  packages/quereus/test/logic/102-schema-catalog-edge-cases.sqllogic
  packages/quereus/test/logic/40-constraints.sqllogic
----

## Root cause

`SchemaManager.dropTable` (packages/quereus/src/schema/manager.ts:430) calls `module.destroy(...)` but does **not await** the returned promise — see the fire-and-forget block at lines 503-506 (`void destroyPromise.then(...)`). The method is declared synchronous and returns before the module's cleanup runs.

For `StoreModule.destroy` (packages/quereus-store/src/common/store-module.ts:263), cleanup involves `await table.disconnect()`, `this.tables.delete(...)`, `await this.provider.deleteTableStores(...)`, and finally `this.stores.delete(tableKey)`. Each `await` yields; because the caller did not block, the next SQL statement can execute concurrently with this cleanup.

Race timeline for `DROP TABLE t; CREATE TABLE t; INSERT INTO t ...`:

1. DROP — `dropTable` kicks off `destroy(...)` and returns. `destroy` yields at `await table.disconnect()`.
2. CREATE — runs `StoreModule.create(...)`. It calls `provider.getStore(schema, t)`. The provider's `getOrCreateStore` (LevelDBProvider.ts:164) sees the **old** `LevelDBStore` still in its `this.stores` map (destroy hasn't yet reached `closeStoreByName`) and returns the old handle. CREATE then `this.stores.set(tableKey, oldStore)` on StoreModule and `this.tables.set(tableKey, newTable)`. The new StoreTable is wired to the old store.
3. destroy resumes — calls `provider.deleteTableStores(...)` → `closeStoreByName(...)` → `await store.close()`. The old store — which is now the store the new StoreTable points at — becomes closed. `removeDir` wipes the directory out from under LevelDB.
4. INSERT — `StoreTable.update` → `ensureStore()` returns the cached closed `this.store` → `store.get(key)` throws `LevelDBStore is closed` (packages/quereus-plugin-leveldb/src/store.ts:108).

Memory-module tables do not hit this: their "close" is synchronous in-process state — the race window is zero. Store modules back onto async resources (LevelDB handle + filesystem), where the race is wide.

The 41-alter-table failure referenced in the source fix ticket (row count 0 after `ALTER TABLE ... RENAME TO ...`) is a **different** bug — `runRenameTable` in packages/quereus/src/runtime/emit/alter-table.ts:83-87 only updates `MemoryTableModule` internal state; StoreModule is never told the table was renamed. That belongs in its own ticket and is not addressed here.

## Fix

Make `SchemaManager.dropTable` return `Promise<boolean>` and `await destroyPromise` before returning. The existing single call site already uses `await`, so signature change is compatible.

```
async dropTable(schemaName: string, tableName: string, ifExists = false): Promise<boolean> {
   ... (existing body) ...
   if (destroyPromise) {
      await destroyPromise;
      log(`destroy completed for VTab %s.%s`, schemaName, tableName);
   }
   return removed;
}
```

Rationale:
- Semantically correct: DROP TABLE should not return until the underlying storage has been torn down. Any subsequent DDL/DML sees a clean slate.
- Minimal: one call site (`packages/quereus/src/runtime/emit/drop-table.ts:24`) — already awaits.
- Avoids per-key locking in every store implementation.

## Defence in depth (secondary hardening)

After the primary fix serializes DROP before CREATE, the following are still good to have to prevent analogous races surfacing from future callers or other DDL paths:

- `LevelDBProvider.closeStoreByName` (packages/quereus-plugin-leveldb/src/provider.ts:179): delete from `this.stores` / `this.storePaths` **before** `await store.close()`, so a concurrent `getOrCreateStore` cannot observe a store that is about to be closed. Today the delete happens after the await.
- `StoreModule.destroy` (packages/quereus-store/src/common/store-module.ts:263): remove the tableKey from `this.tables`, `this.stores`, and `this.coordinators` **before** any `await`. Keeps the module's map consistent with the "about to be destroyed" state across microtask boundaries.

These two tweaks narrow the race window even without the schema-manager change; combined with the schema-manager fix they make the code robust even if a caller forgets to await.

## TODO

- Add a focused unit test in `packages/quereus-store/test/` reproducing DROP/CREATE/INSERT on the same key under a real KV provider (the in-memory test provider will not expose the LevelDB-style race, so the test should use a stubbed provider that also has async close). Simpler alternative: rely on the existing sqllogic regressions once `QUEREUS_TEST_STORE=true` is run.
- Update `SchemaManager.dropTable` signature to `Promise<boolean>` and await `destroyPromise` before returning.
- Update the return type doc comment and any `.d.ts`-relevant consumers.
- Verify `packages/quereus/src/runtime/emit/drop-table.ts:24` still compiles (already `await`s).
- (Defence in depth) Reorder `LevelDBProvider.closeStoreByName` to delete-then-close.
- (Defence in depth) Reorder `StoreModule.destroy` to clear its three internal maps synchronously at the top of the method.
- Run `yarn test` — all default tests should pass.
- Run `yarn test:store` — `40-constraints.sqllogic` and `102-schema-catalog-edge-cases.sqllogic` should both pass. `41-alter-table.sqllogic:104` may still fail; that belongs to the sibling rename ticket.
