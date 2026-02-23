---
description: Review fixes for three isolation layer overlay bugs (savepoint rollback, insert-after-delete)
dependencies: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts
---

# Isolation Layer Overlay Bug Fixes — Review

## Summary

Three bugs in the isolation layer's overlay handling were fixed in `packages/quereus-isolation/src/isolated-table.ts`. All three previously-skipped tests are now unskipped and passing (60/60 tests pass). Core quereus tests (668 passing) are unaffected.

## Bug 1 & 2: Savepoint rollback did not restore prior overlay state

**Root cause:** Two distinct issues with savepoint coordination:

1. **Double-push on savepointStack:** When the database issued `SAVEPOINT`, it called `createSavepoint(depth)` on all registered connections. The overlay's `MemoryVirtualTableConnection` (registered by `MemoryTable.ensureConnection()`) and the `IsolatedConnection`'s callback (`onConnectionSavepoint` → `overlayTable.savepoint()`) both called `createSavepoint` on the **same** underlying `MemoryTableConnection`. This doubled entries in the `savepointStack`, so `rollbackToSavepoint(depth)` used the wrong stack index.

2. **Savepoint before overlay creation:** When a savepoint was created before any writes (overlay didn't exist yet), no snapshot was recorded. When the overlay was later created by a write, its new connection had no savepoint, so rollback was a no-op.

**Fix:**
- `onConnectionSavepoint`: No-op when overlay exists (its registered connection handles it). When overlay doesn't exist, records the savepoint depth in `savepointsBeforeOverlay`.
- `onConnectionRollbackToSavepoint`: If target depth is in `savepointsBeforeOverlay`, clears the entire overlay (restoring "no uncommitted changes").
- `onConnectionReleaseSavepoint`: Cleans up tracking state.
- `onConnectionCommit/onConnectionRollback`: Clears `savepointsBeforeOverlay`.

**Tests:** `'nested savepoints rollback independently'`, `'savepoint with update and delete operations'`

## Bug 3: Insert after delete caused UNIQUE constraint violation

**Root cause:** The `update()` method's `'insert'` case appended `tombstone=0` and called `overlay.update({ operation: 'insert', ... })`. When a row was deleted (tombstone inserted), then re-inserted with the same PK, the overlay already had a row with that PK (the tombstone), causing a UNIQUE constraint failure.

**Fix:** Before inserting, check `getOverlayRow(pk)`. If a tombstone exists for that PK, switch to an `update` operation to convert the tombstone back to a regular row (`tombstone=0`) instead of inserting a new row.

**Test:** `'delete-all then re-insert works'`

## Files changed

- `packages/quereus-isolation/src/isolated-table.ts` — All three bug fixes
- `packages/quereus-isolation/test/isolation-layer.spec.ts` — Unskipped three tests

## Validation

- `npm test --workspace=packages/quereus-isolation`: 60/60 passing
- `npm test --workspace=packages/quereus`: 668 passing, 7 pending (pre-existing)
- `npm run build --workspace=packages/quereus-isolation`: clean
