---
description: `DROP INDEX` inside an active transaction with a live overlay does not propagate cleanly to the per-connection overlay's `MemoryTable`. After `BEGIN; INSERT; DROP INDEX; INSERT (duplicate);`, the duplicate still fires `UNIQUE constraint failed` from the overlay's MemoryTable because `MemoryTableManager.dropIndex` calls `ensureSchemaChangeSafety` which cannot cleanly consolidate while the connection's transaction layer is active, and the synthesized `UniqueConstraintSchema` survives on the overlay's cached schema.
files:
  packages/quereus-isolation/src/isolation-module.ts        # IsolationModule.dropIndex (autocommit path works; in-transaction overlay refresh broken)
  packages/quereus-isolation/src/isolated-table.ts          # ensureOverlay + checkMergedUniqueConstraints
  packages/quereus/src/vtab/memory/layer/manager.ts         # ensureSchemaChangeSafety, dropIndex
  packages/quereus-isolation/test/isolation-layer.spec.ts   # add the in-transaction regression test
---

## Repro

Discovered during review of `store-table-drop-index-schema-not-updated`.
The autocommit path (the canonical engine-level
`drop-unique-index.sqllogic`) works after the review pass added
`IsolationModule.dropIndex`. The in-transaction path does not:

```ts
const isolatedModule = new IsolationModule({ underlying: new MemoryTableModule() });
db.registerModule('isolated', isolatedModule);

await db.exec(`CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER) USING isolated`);
await db.exec(`CREATE UNIQUE INDEX t_b ON t (b)`);

await db.exec(`BEGIN`);
await db.exec(`INSERT INTO t VALUES (1, 100)`);  // creates overlay; UC active
await db.exec(`DROP INDEX t_b`);
await db.exec(`INSERT INTO t VALUES (2, 100)`);  // should succeed; currently fails:
// → ConstraintError: UNIQUE constraint failed: _overlay_t_<id> (b)
await db.exec(`COMMIT`);
```

## What's broken

`IsolationModule.dropIndex` (added during the review of the parent
ticket) iterates `connectionOverlays` and calls
`overlayState.overlayTable.dropIndex?.(indexName)`. The overlay is a
`MemoryTable`, which forwards to `MemoryTableManager.dropIndex` →
`ensureSchemaChangeSafety()`. With an active overlay connection holding
a transaction layer, the consolidation either fails outright (BUSY) or
completes-but-doesn't-refresh the per-connection layer's effective
schema, and the synthesized `UniqueConstraintSchema` tagged
`derivedFromIndex=t_b` keeps firing inside the overlay's UC check on
the next write.

## Why it matters

Once `IsolationModule.dropIndex` exists (parent ticket's review pass),
the autocommit case works, which closes the most common reading of
"DROP INDEX bug under isolation". But interactive transactions
(`BEGIN ... DROP INDEX ... <DML> ... COMMIT`) are a documented
isolation-supported scenario and silently misbehave. No engine
sqllogic test exercises in-transaction DDL today, so this is invisible
from the default test suite — but it's a real semantic gap.

## Investigation hints

- `MemoryTableManager.ensureSchemaChangeSafety`
  (`packages/quereus/src/vtab/memory/layer/manager.ts:1397-1423`) walks
  `_currentCommittedLayer !== baseLayer` → `consolidateToBaseLayer()`,
  then re-points every connection's `readLayer = baseLayer`. The
  consolidate path may not unwind a connection's *write* layer (the
  uncommitted transaction the overlay is still building), only the
  committed history. Confirm what state the overlay's connection is in
  when `dropIndex` enters here.
- `IsolatedTable.checkMergedUniqueConstraints` reads
  `this.tableSchema?.uniqueConstraints`, but the actual `UNIQUE
  constraint failed: _overlay_t_<id> (b)` message in the failing run
  uses the *overlay's* table name — confirming the error is fired
  from inside `overlay.update(...)` against the overlay's own
  `MemoryTableManager.tableSchema`, not the IsolatedTable's merged
  view. So the fix must drive the overlay's manager schema, not just
  the IsolatedTable's.
- Compare against `ALTER TABLE` (`IsolationModule.alterTable`,
  `packages/quereus-isolation/src/isolation-module.ts:329-367`) which
  handles in-transaction schema change by migrating overlays via
  `migrateOverlayForAlter`. A similar `migrateOverlayForDropIndex`
  (or simply tear-down-and-rebuild-overlay) is likely the right shape.

## Notes

- The defensive `overlayState.overlayTable.dropIndex?.(indexName)`
  loop in `IsolationModule.dropIndex` was kept (no-op in autocommit
  since no overlay exists between statements). It's the right
  plumbing for this fix to build on; the bug is that today it doesn't
  actually refresh the overlay's effective schema mid-transaction.
- Engine-level `drop-unique-index.sqllogic` does not exercise this
  (all autocommit). A new regression case should be added in
  `isolation-layer.spec.ts` under
  `'DROP INDEX forwards through the isolation layer'` once fixed.
