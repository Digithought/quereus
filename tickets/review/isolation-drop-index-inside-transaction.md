---
description: Fixed `IsolationModule.dropIndex` so that `DROP INDEX` inside an active transaction with a live overlay no longer keeps firing the synthesized `UNIQUE` constraint on subsequent overlay writes. Replaced the bare `overlay.dropIndex()` forward (which leaves the overlay's `MemoryTable` pending `TransactionLayer.tableSchemaAtCreation` frozen with the old UC) with a true overlay rebuild via a new `migrateOverlayForDropIndex` helper that mirrors `migrateOverlayForAlter`. Adds an in-transaction regression test.
files:
  packages/quereus-isolation/src/isolation-module.ts                         # IsolationModule.dropIndex + migrateOverlayForDropIndex
  packages/quereus-isolation/test/isolation-layer.spec.ts                    # in-transaction regression test
  packages/quereus/src/vtab/memory/layer/manager.ts                          # reference: ensureSchemaChangeSafety / dropIndex (unchanged)
  packages/quereus/src/vtab/memory/layer/transaction.ts                      # reference: tableSchemaAtCreation (the frozen schema)
---

## Summary

Before this fix, `IsolationModule.dropIndex` (added during the parent
ticket's review pass) forwarded `dropIndex` to each per-connection
overlay via `overlay.dropIndex?.(indexName)`. That call eventually
reaches `MemoryTableManager.dropIndex` which:

1. Runs `ensureSchemaChangeSafety()` — only updates each connection's
   `readLayer = baseLayer`. It does **not** unwind a connection's
   `pendingTransactionLayer` (the active *write* layer for the open
   overlay transaction).
2. Refreshes `manager.tableSchema` and `baseLayer` schema to drop the
   index and the synthesized `UniqueConstraintSchema`.

But `TransactionLayer.tableSchemaAtCreation` is frozen at layer
creation time (`transaction.ts:60`). Subsequent overlay writes go
through `manager.performInsert(targetLayer, ...)`, which reads
`targetLayer.getSchema()` — i.e. the still-stale schema with the UC.
So `INSERT (2, 100)` after the drop kept failing with
`UNIQUE constraint failed: _overlay_<table>_<id> (b)` from the
overlay's own UC check.

## Fix

`IsolationModule.dropIndex` now, after delegating to the underlying
module, rebuilds every affected per-connection overlay against the
post-drop underlying schema. The new helper
`migrateOverlayForDropIndex` mirrors `migrateOverlayForAlter`:

- Reads the post-drop schema from `state.underlyingTable.tableSchema`.
- Builds a fresh overlay schema via `createOverlaySchema(updated)` and
  creates a new overlay `MemoryTable`.
- Copies all staged rows (data + tombstone column verbatim — DROP
  INDEX preserves column layout).
- Replaces the `connectionOverlays` entry.

A fresh `MemoryTable` means a fresh `TransactionLayer` on the next
write, so `tableSchemaAtCreation` captures the post-drop schema and
the synthesized UC no longer fires.

## Test

Added `clears the synthesized UNIQUE constraint after DROP INDEX
inside an active transaction` in
`packages/quereus-isolation/test/isolation-layer.spec.ts` under the
existing `'DROP INDEX forwards through the isolation layer'` describe
block. It runs the exact `BEGIN; INSERT; DROP INDEX; INSERT
(duplicate); COMMIT` scenario from the original repro and verifies
both rows land.

## Validation

- `yarn workspace @quereus/isolation run build` — clean.
- `yarn workspace @quereus/isolation run test` — 66 passing
  (includes the new regression).
- `yarn test` — 3021 passing in `quereus`, all
  isolation/store/sync/etc. green. The only remaining 2 failures are
  in `@quereus/sample-plugins` (`Comprehensive Demo Plugin
  key_value_store virtual table supports delete/update`); confirmed
  pre-existing on `fd` baseline (reproduced after `git stash`),
  unrelated to this fix.

## Notes for the reviewer

- The fix follows the exact pattern of `migrateOverlayForAlter`
  (rebuild + replay rows). I considered factoring out a shared
  "rebuild overlay with row transform" helper, but the alter case
  needs a per-change row translator (`translateOverlayRow`) and the
  drop-index case needs no translation, so a tiny dedicated helper
  keeps each call site readable. Worth a look if a third migrator
  appears (CREATE INDEX inside a transaction, currently out of scope
  but symmetrical).
- `IsolatedConnection.overlayConnection` is **not** re-pointed to a
  connection on the new overlay table. In the regression scenario
  this is harmless because, in the basic flow, `ensureConnection()`
  was first called BEFORE `ensureOverlay()`, so the
  `IsolatedConnection`'s `overlayConnection` is `undefined` to begin
  with — the overlay's `MemoryTable` manages its own internal
  connection on each `update()`. The same omission already exists in
  `migrateOverlayForAlter`; if a future scenario surfaces a
  registered overlay connection that needs to follow the rebuild
  (e.g. the `savepointsBeforeOverlay > 0` pre-aligned connection
  path in `IsolatedTable.ensureOverlay`), both migrators would need
  to be updated together.
- This fix does not address the analogous `CREATE INDEX inside an
  active transaction` case, where a UC added mid-transaction would
  not fire on the overlay. That is a separate (rarer, opposite-sign)
  semantic gap; flag for a follow-up backlog ticket if the reviewer
  agrees it warrants one.
- The engine-level `MemoryTableManager.ensureSchemaChangeSafety`
  remains untouched. Patching it to also unwind pending write layers
  during DDL would be more invasive (TransactionLayer treats its
  schema as immutable through its lifetime) and would still need the
  overlay rebuild to broadcast through the IsolatedTable pathway, so
  the rebuild approach is both narrower and correct.
