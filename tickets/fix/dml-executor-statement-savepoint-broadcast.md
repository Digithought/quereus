---
description: Statement-scope savepoint for non-FAIL DML modes (ABORT default, IGNORE, REPLACE, ROLLBACK) needs to broadcast SAVEPOINT/RELEASE/ROLLBACK TO to every registered virtual-table connection — analogous to the SQL-level SAVEPOINT pattern in `transaction.ts` — so per-connection savepoint stacks (memory's `MemoryTableConnection.savepointStack`, lamina's `LaminaVTabConnection.savepointMarks`) stay in sync with the `TransactionManager` depth.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/runtime/emit/transaction.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/vtab/memory/layer/connection.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
---

# DML statement-scope savepoint must broadcast to all connections

## Background

ABORT semantics (the default for `INSERT ... VALUES (...)` without an explicit
OR clause) require that a mid-statement constraint rejection unwinds rows the
statement already inserted, even in autocommit mode where no explicit BEGIN
exists. The current `runInsert` in `dml-executor.ts` only opens a per-row
savepoint when `plan.onConflict === ConflictResolution.FAIL`. For non-FAIL
modes (ABORT default, IGNORE, REPLACE, ROLLBACK) it does not wrap a
statement-scope savepoint at all.

## What broke

A prior attempt to add this wrapping (committed in `0d5cfaf2` and extended in
`f00346b2` as part of the now-reviewed `rename-rewriter-check-subquery-shadowing`
ticket) was reverted in the review pass because:

1. **Out-of-scope** for the rename-rewriter ticket it was bundled with.
2. **Caused test regressions**:
   - `0d5cfaf2` (fix stage of rename-rewriter ticket): introduced the
     statement-scope savepoint wrap; `95-assertions.sqllogic:202` started
     failing with `Row count mismatch. Expected 1, got 0` (`select val from sp_data`).
   - `f00346b2` (implement stage of rename-rewriter ticket): extended the
     wrap to broadcast `connection.createSavepoint(depth)` /
     `releaseSavepoint(depth)` / `rollbackToSavepoint(depth)` to every
     registered connection (mirroring `transaction.ts`); `01.5-insert-select.sqllogic`
     then started failing with `Type mismatch for column 'val': expected
     INTEGER, got number` (originating in `MemoryTableManager.performInsert`).
3. Also added stray `console.log('[DBG MEM ...]')` instrumentation in
   `connection.ts` / `manager.ts` that should not land in checked-in code.

After the revert (review commit at the head of `fd`) all 3175 tests pass.

## What we want

Re-introduce the statement-scope savepoint wrap for non-FAIL DML modes, with
the per-connection broadcast, **without** regressing the two failing tests
above. Investigate why each test broke before re-implementing:

- `95-assertions.sqllogic` exercises a stored procedure that issues SAVEPOINT
  / ROLLBACK TO at user level. The hypothesis embedded in the reverted code's
  comment is that the new statement-scope savepoint offsets user-level
  savepoints by one in the per-connection stack — verify by tracing the depth
  numbers under both regimes.
- `01.5-insert-select.sqllogic` fails inside the memory-vtab insert path with
  a Type mismatch on `val: expected INTEGER, got number`. Likely the
  per-connection savepoint snapshot's row-copy loop in
  `MemoryTableConnection.createTransactionSnapshot` is round-tripping rows
  through a code path that doesn't preserve the logical-type wrapper, but
  confirm from the failing row's value (capture it via test driver
  instrumentation).

The reverted implementation pattern from the implement commit was:
```ts
if (stmtSavepointName) {
    const depth = ctx.db._createSavepoint(stmtSavepointName);
    for (const connection of ctx.db.getAllConnections()) {
        await connection.createSavepoint(depth);
    }
}
```
mirroring `runtime/emit/transaction.ts`'s explicit SAVEPOINT path. The
mechanical pattern is correct — the bugs are downstream (one or both of:
duplicate depth-replay in `Database.registerConnection`, layer-snapshot type
loss in memory's snapshot copy, or off-by-one in the lamina mark stack).

## Out of scope

- Non-INSERT DML paths (UPDATE/DELETE) — they may have the same gap, but
  scope creep risks. File follow-ups if surfaced.
