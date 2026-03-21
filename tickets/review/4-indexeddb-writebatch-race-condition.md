description: IndexedDB WriteBatch.write() races with database upgrade, throws "Database not open"
dependencies: none
files:
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-indexeddb/src/manager.ts
  - packages/quereus-store/src/common/cached-kv-store.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
----

## Problem

`IndexedDBWriteBatch.write()` (store.ts:~245) calls `this.manager.getDatabase()` synchronously, which returns the current `this.db` reference. If a version upgrade is in progress, `doUpgrade()` (manager.ts:~214) has already called `this.db?.close()` and set `this.db = null`, so `getDatabase()` returns null and the write throws `"Database not open"`.

This is a race condition: other store methods (`get`, `put`, etc.) use `await this.manager.ensureOpen()` which serializes against upgrades, but `WriteBatch.write()` does not.

### Observed symptoms

```
sync-manager-impl.ts:228 [Sync] Error handling data change: Error: Database not open
    at IndexedDBWriteBatch.write (store.ts:245)
    at CachedWriteBatch.write (cached-kv-store.ts:267)
    at SyncManagerImpl.handleDataChange (sync-manager-impl.ts:217)
```

Often accompanied by:

```
IndexedDB upgrade to create 'account.allscenario' is blocked, waiting for other connections to close...
```

The upgrade blocking widens the race window — while blocked, data change events from the sync manager fire and try to write to the now-closed database.

### Impact

Failed writes lose critical sync metadata (HLC state, column versions, tombstones), which can corrupt CRDT tracking and cause data inconsistency.

## Fix

`IndexedDBWriteBatch.write()` and `MultiStoreWriteBatch.write()` should call `await this.manager.ensureOpen()` instead of `this.manager.getDatabase()`, matching the pattern used by `get()`, `put()`, and other store methods. This ensures the write waits for any in-progress upgrade to complete and the database to reopen.

Additionally, `deleteObjectStore()` should serialize via `upgradePromise` the same way `ensureObjectStore()` does, so that `ensureOpen()` callers wait for deletions too.

## TODO

- [x] In `store.ts` `IndexedDBWriteBatch.write()`, replace synchronous `getDatabase()` with `await this.manager.ensureOpen()`
- [x] In `store.ts` `MultiStoreWriteBatch.write()`, apply the same fix
- [x] In `manager.ts` `deleteObjectStore()`, serialize via `upgradePromise` to prevent concurrent operations
- [x] Verify `CachedWriteBatch.write()` in cached-kv-store.ts doesn't need its own guard (it delegates to inner batch — confirmed OK)
- [ ] Add a test that triggers a write batch during a version upgrade and verifies it completes without error
- [ ] Consider whether `doUpgrade()` should drain pending writes before closing the database
