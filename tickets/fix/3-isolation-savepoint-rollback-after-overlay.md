---
description: Savepoint rollback through isolation overlay does not undo writes when the overlay was created after the savepoint
files:
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/src/isolated-connection.ts
  - packages/quereus/test/logic/04-transactions.sqllogic
  - packages/quereus/test/logic.spec.ts
---

## Symptom

`04-transactions.sqllogic` is in the `MEMORY_ONLY_FILES` skip list at `logic.spec.ts:40`
with the comment:

> savepoint rollback in overlay does not undo writes when overlay was created after the
> savepoint (isolation-layer limitation)

The skip exists so `yarn test:store` (LevelDB-backed runs) passes, but the underlying
correctness gap means store-mode users can lose savepoint rollback semantics for any
table that becomes overlay-resident only after the savepoint was taken.

## Background

`isolated-table.ts:147-162` already contains a partial fix for the inverse direction — when
savepoints exist before the overlay is created, it pre-aligns the overlay connection's
savepoint stack so that broadcast `rollbackToSavepoint(depth)` calls land on a real layer.
The remaining gap is the case where: (a) `SAVEPOINT s1` opens, (b) writes go to the
underlying store via the isolation overlay, (c) the overlay is created lazily for some
table during the savepoint window, (d) `ROLLBACK TO s1` does not unwind those overlay
writes because they sit on a layer above the savepoint marker.

## Acceptance

- Identify the exact sequence in `04-transactions.sqllogic` that fails under
  `QUEREUS_TEST_STORE=1`; remove the file from `MEMORY_ONLY_FILES` once fixed.
- Add focused regression tests covering: savepoint → overlay-create → write → rollback;
  nested savepoints with mid-stack overlay creation; overlay-create on a table never
  written to before the savepoint.
- Cross-check interaction with `3-isolation-savepoint-rollback-undefined-schema.md`
  (already complete) to make sure that fix's invariants are preserved.
- `yarn test` and `yarn test:store` both green.
