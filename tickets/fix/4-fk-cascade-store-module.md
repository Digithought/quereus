description: FK `on delete cascade` leaves orphaned child rows when using the store-module (IndexedDB-backed) vtab
dependencies:
files:
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/core/database.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/transaction.ts
  packages/quereus-sync/src/sync/sync-manager-impl.ts
----

## Symptom

A parent-table `DELETE` that should cascade into child tables via `foreign key (...) references Parent(id) on delete cascade` leaves the child rows behind **when the tables are backed by `@quereus/store`'s `StoreModule` (IndexedDB)**. SiteCAD observed this on `TerrainLayer` → `TerrainTile` / `ImageryTile` / `SplatmapTile` / `ModelClip`: after `delete from TerrainLayer where id = ?`, the `TerrainTile` rows owned by that layer are still returned by `select * from TerrainTile` (and still persist across page reloads).

The same schema, same DELETE, against the in-memory `memory` vtab behaves correctly:

- Child rows are gone from subsequent `SELECT`s.
- `db.onDataChange` fires native events for each cascade-deleted child row, in order, followed by the parent delete event.

Verified in a SiteCAD test using `getScenarioSchemaDeclaration()` through `mock-db` (memory vtab):

```
native events after delete: [
  { table: 'TerrainTile',  type: 'delete' },
  { table: 'TerrainTile',  type: 'delete' },
  { table: 'TerrainLayer', type: 'delete' }
]
```

Production uses `StoreModule` (bound via `db.registerModule(scope, new StoreModule(provider, storeEvents))` in `packages/site-cad/src/lib/db/quereus-worker.ts`). In that path the child rows are not removed.

## What works (confirmed)

- Schema parse: the `foreign key … on delete cascade` clause survives `buildSchemaDeclaration('scenario')` → `db.exec(schemaSQL)` → `apply schema scenario with seed`.
- In-memory cascade: `runDelete` (`runtime/emit/dml-executor.ts:482–552`) calls `executeForeignKeyActions(ctx.db, tableSchema, 'delete', oldRow)` at line 540. `foreign-key-actions.ts:99–104` builds `DELETE FROM "childTable" WHERE …` and runs it via `db._execWithinTransaction(sql, oldParentValues)`. Against memory tables this produces correct deletions and events.

## Hypotheses

The memory vtab and the store vtab diverge in how they coordinate a nested DML reentry. For a cascade delete:

1. Outer `delete from TerrainLayer` → `runDelete` for TerrainLayer → `vtab.update({operation:'delete'})` on TerrainLayer's store-table connection. store-table's `case 'delete'` queues `coordinator.delete(key)` and `coordinator.queueEvent(deleteEvent)` for that **table's** coordinator (`packages/quereus-store/src/common/store-table.ts:577–613`).
2. `executeForeignKeyActions` issues a nested `DELETE FROM "TerrainTile" WHERE "layer_id" = ?` through `db._execWithinTransaction(sql, params)`.
3. The nested statement is parsed + planned, `runDelete` runs for TerrainTile. Opening the TerrainTile store-table requires `getVTable` → `connect()` → `registerConnection()`. `database.ts:1366–1384` calls `connection.begin()` on the newly-registered connection *if we're already in a transaction* — so the new connection joins the outer transaction.
4. Each child row goes through `vtab.update({operation:'delete'})` on TerrainTile's store-table. store-table's `inTransaction` branch calls `coordinator.delete(key)` on **TerrainTile's** coordinator.
5. End of outer implicit transaction → `commitTransaction()` iterates `ctx.getAllConnections()` and calls `connection.commit()` on each. Both TerrainLayer and TerrainTile connections should commit and flush their per-table coordinators to the underlying KV store. Batched events should flow out via `flushBatch()`.

Where this could still be broken (any one is enough to explain the symptom):

- **A.** Nested `_execWithinTransaction` runs before the outer `runDelete`'s own `vtab.update` has returned. If `getVTable` for TerrainTile opens a fresh store-table connection whose `inTransaction` flag is not yet set (or whose coordinator isn't linked to the outer transaction boundary), `coordinator.delete(key)` may land on a coordinator that never commits — the row stays live in the KV store.
- **B.** `runDelete`'s `try { … } finally { await disconnectVTable(ctx, vtab); }` runs for the nested call, disconnecting TerrainTile's vtab instance before the outer transaction commits. If disconnect drops any pending per-connection state held outside the coordinator (e.g. in-flight queues, schema-side caches), those deletes never reach the KV store. See `disconnectVTable` in `runtime/utils.ts:161` and `StoreTable.disconnect` equivalent in `quereus-store`.
- **C.** The per-table store coordinator queues deletes + events inside the nested reentry, but the batched events are never flushed to listeners because the outer `flushBatch()` happens on the database-level event emitter that hasn't seen a `hookModuleEmitter` registration for TerrainTile's store module instance at this point.
- **D.** The sync-manager in `@quereus/sync` (`sync-manager-impl.ts:154–156`) subscribes to `storeEvents.onDataChange` to capture local mutations for CRDT column-version metadata. If cascade deletes don't surface through `storeEvents`, their metadata isn't recorded and they are not persisted through the write path driven by that listener.

Determining which of A–D is the true cause is the first task in this ticket. The reproducing test should verify, in order:

1. Directly against a `StoreModule` instance with a memory-backed KV (e.g. `createMemoryKVStore()`): issue the parent delete, then `SELECT count(*) FROM child_table`. Expect 0, observe >0 to reproduce.
2. Instrument `store-table.ts` `case 'delete'` and the coordinator to log each `delete(key)` call. Confirm whether cascade-originated deletes reach the coordinator at all.
3. If they do reach the coordinator, log the coordinator's commit / flush path to see whether the queued deletes are applied to the underlying KV store.
4. Confirm whether `storeEvents.emitDataChange` fires for cascade-deleted rows.

## Expected behavior

Any path that deletes a parent row must remove all child rows reachable via `on delete cascade`, and must do so **regardless of the vtab module backing the tables**. Observable via:

- `SELECT count(*) FROM child_table WHERE parent_fk = <deleted>` returns 0 immediately after the parent delete.
- `db.onDataChange` emits one `delete` event per cascaded child row, followed by the parent delete event, inside the same transaction flush.
- Reopening the database (fresh `StoreModule` over the same persistent KV) does not resurrect child rows.

## Use case

SiteCAD scenarios have a `TerrainLayer` stack with per-layer owned tiles (`TerrainTile`, `ImageryTile`, `SplatmapTile`) and `ModelClip`. The user (UI, scripts, agents) can delete any layer; reactive listeners driven by `db.onDataChange` rely on cascade events to refresh the in-memory ground-model cache and invalidate Cesium's terrain tiles. A partial cascade breaks two things at once: the in-memory cache reload sees stale rows, and the IndexedDB store silently accumulates orphaned tile rows that survive page reload.

The SiteCAD-side code is intentionally **not** carrying a manual cleanup workaround — it trusts the DB. See `packages/site-cad/src/lib/ground-model/index.ts` (reactive invalidate listener, coalesced via microtask) and `packages/site-cad/src/lib/commands.ts:createRemoveLayerCommand` (two-statement composite: delete parent + compact sequences).

## TODO

- Write a reproducing test in `packages/quereus-store/test` that sets up a parent/child schema with `on delete cascade`, populates rows, deletes the parent, and asserts child rows are gone from both `SELECT` and the underlying KV store.
- Narrow the failure to one of hypotheses A–D by instrumenting `store-table.ts` delete path + the coordinator's commit/flush.
- Fix the identified gap. Candidate fixes depending on cause:
  - **A**: ensure nested-reentry `getVTable` wires TerrainTile's store-table into the outer transaction before `vtab.update` runs.
  - **B**: defer `disconnectVTable` for nested reentry until the outer transaction commits (mirror the existing `unregisterConnection` deferral in `database.ts:1394`).
  - **C**: ensure the child store module's event emitter is hooked to the database event emitter before the nested DML runs, so queued events reach `flushBatch`.
  - **D**: have `@quereus/sync`'s `handleDataChange` subscribe to the right event source so cascade-originated deletes are captured for CRDT metadata and persistence.
- Add a regression test at the `db.onDataChange` level that asserts cascade deletes emit per-child events in order.
- Verify the fix against the SiteCAD repro: delete a `TerrainLayer` with owned tiles, confirm `TerrainTile` count drops to 0 immediately and after page reload.
