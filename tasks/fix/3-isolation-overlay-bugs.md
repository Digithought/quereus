---
description: Fix three bugs in isolation layer overlay handling (savepoint rollback, insert-after-delete)
dependencies: packages/quereus-isolation/src/isolated-table.ts
priority: 3
---

# Isolation Layer Overlay Bugs

Three bugs found during review, with failing tests already in place (marked `.skip` in `packages/quereus-isolation/test/isolation-layer.spec.ts`).

## Bug 1: Savepoint rollback does not restore prior overlay state

**Symptom**: After `ROLLBACK TO SAVEPOINT sp_inner`, changes made before the inner savepoint are also lost. Rolling back an inner savepoint rolls back the outer savepoint's changes too.

**Location**: `packages/quereus-isolation/src/isolated-table.ts` — `onConnectionRollbackToSavepoint()` (line ~945) delegates to `overlay.rollbackTo()`. The overlay (memory vtab) rollback-to-savepoint implementation may not properly maintain state from before the savepoint.

**Hypothesis**: The overlay module's `rollbackToSavepoint` discards all changes since the *transaction began* rather than since the savepoint was created. Or the savepoint index coordination between the isolation layer and overlay module is mismatched.

**Test**: `isolation-layer.spec.ts` → `'nested savepoints rollback independently'` (currently `.skip`)

## Bug 2: Savepoint rollback does not restore deleted/updated rows

**Symptom**: After deleting a row then rolling back to a savepoint created before the delete, the row is not restored.

**Location**: Same as Bug 1 — the overlay's rollback-to-savepoint does not properly undo tombstone insertions or row modifications.

**Test**: `isolation-layer.spec.ts` → `'savepoint with update and delete operations'` (currently `.skip`)

## Bug 3: Insert after delete causes UNIQUE constraint violation

**Symptom**: After `DELETE FROM t WHERE id = X` then `INSERT INTO t VALUES (X, ...)`, a `ConstraintError: UNIQUE constraint failed` occurs.

**Location**: `packages/quereus-isolation/src/isolated-table.ts` — `update()` method's `'insert'` case (lines ~506-518). When inserting, it appends `tombstone=0` to the values and calls `overlay.update({ ...args, values: overlayRow })`. But the overlay already has a tombstone row with that PK from the delete. The insert should detect the existing tombstone and convert it to a regular row (update `tombstone=0`) rather than inserting a new row.

**Fix approach**: In the insert path, check `getOverlayRow(pk)` first. If a tombstone exists, switch to an update operation on the overlay instead of an insert.

**Test**: `isolation-layer.spec.ts` → `'delete-all then re-insert works'` (currently `.skip`)

## TODO

- [ ] Fix insert-after-delete (Bug 3) — check for existing tombstone in overlay during insert
- [ ] Investigate and fix savepoint rollback (Bugs 1 & 2) — verify overlay module's savepoint semantics
- [ ] Un-skip the three test cases and verify they pass

