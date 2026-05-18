---
description: Re-introduce the statement-scope savepoint wrap for non-FAIL INSERT (ABORT default / IGNORE / REPLACE / ROLLBACK) with the per-connection create/release/rollback-to broadcast pattern from `transaction.ts`, AND fix the eager `pendingTransactionLayer` creation in `MemoryTableConnection.createSavepoint` that the broadcast exposes. Both changes are required together — the broadcast alone causes a halloween-problem regression in self-referential `INSERT ... SELECT`; the lazy-pending-snapshot fix alone leaves the existing fix-stage 95-assertions failure intact.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/vtab/memory/layer/connection.ts
---

# DML statement-scope savepoint broadcast — implementation

## Root causes (verified by fix-stage instrumentation)

### Bug A — `95-assertions.sqllogic:202` Row count mismatch (fix-stage commit `0d5cfaf2`)

The fix-stage code opened a `_createSavepoint('__or_abort_X')` on the DB
`TransactionManager` around each non-FAIL INSERT but did **not** broadcast
release/rollback-to to per-connection state.

Trace for the failing `sp_data` block (sp_data connection #7,
instrumentation removed before final commit):

| step | TxnMgr stack | conn savepointStack | conn pending |
|------|--------------|---------------------|--------------|
| BEGIN                                  | []                                 | []                              | null            |
| INSERT(1,10) → `_createSavepoint('__or_abort_0')` (depth 0, no broadcast) | `['__or_abort_0']` | unchanged                       | null            |
| getVTable → `Database.registerConnection` replays active depth 1 onto the new memory connection: `connection.createSavepoint(0)` | unchanged | `[empty_snap_1024]` (eager pending layer #1023 created)| #1023 (empty)|
| INSERT row writes (1,10) into #1023 | unchanged | unchanged                       | #1023 (1,10)    |
| `_releaseSavepoint('__or_abort_0')` (no broadcast) | `[]`               | **still** `[empty_snap_1024]`   | #1023 (1,10)    |
| SAVEPOINT sp1 → `_createSavepoint('sp1')` returns depth 0 → broadcast `createSavepoint(0)` | `['sp1']` | `[empty_snap_1024, snap_1025_with_(1,10)]` (push, not assignment) | #1023 (1,10) |
| INSERT(2,-5) similar, but final release returns to depth 1 | `['sp1']` | unchanged                       | #1023 (1,10),(2,-5)|
| ROLLBACK TO sp1 → broadcast `rollbackToSavepoint(0)` | `['sp1']` (preserved) | target stack[0] = **empty_snap_1024**; pending reset to TransactionLayer(empty_snap_1024) | new #1026 (empty), parent empty_snap_1024 |
| COMMIT — pending #1026 promoted to committed; reads see only its empty inheritance | — | — | — |

Connection #7's `savepointStack[0]` was populated by the
`registerConnection` replay during the **stmt** savepoint, and the
fix-stage code never broadcast the matching release. When the user's
`SAVEPOINT sp1` later took depth 0 in TxnMgr, the memory connection
pushed its real snapshot at index **1**, leaving the empty placeholder
at index 0. `ROLLBACK TO sp1` (depth 0 in TxnMgr) then restored the
empty placeholder. The (1,10) row was lost.

**Fix A:** broadcast all three operations to every active connection,
exactly mirroring the SQL-level pattern in `runtime/emit/transaction.ts`.

### Bug B — `01.5-insert-select.sqllogic` Type mismatch (implement-stage commit `f00346b2`)

Once the broadcast was added, the failing row in test #7's
self-referential INSERT was `[4902, 11258999068426240]` — verified by
adding a try/catch around `validateAndParse` in
`MemoryTableManager.performInsert` and JSON-logging the value. The
arithmetic decomposes as:

- `4902 = 2 + 100 × 49`
- `11258999068426240 = 20 × 2^49 = 10 × 2^50`

So the SELECT had been doubling its own writes 49–50 times before
`Number.isSafeInteger(val)` finally returned `false` and
`INTEGER_TYPE.validate` rejected it. Classic **halloween problem**.

Cause: `MemoryTableConnection.createSavepoint(depth)` eagerly creates a
`pendingTransactionLayer` if none exists:

```ts
if (!this.pendingTransactionLayer) {
    this.pendingTransactionLayer = new TransactionLayer(this.tableManager.currentCommittedLayer);
}
```

Then `MemoryTable.query()` (line 231 of `vtab/memory/table.ts`)
selects the read-source as `conn.pendingTransactionLayer ?? conn.readLayer`.
With the broadcast, the stmt savepoint creates the pending layer at the
start of the INSERT, *before* the SELECT begins iterating. The SELECT
now reads from the pending layer, and BTree inheritance walks into the
committed layer for the seed rows — but as soon as `processInsertRow`
writes a new row into the **same** pending layer, the SELECT's iterator
sees the new key and the doubling cascade begins.

Without the broadcast the eager creation never fires (no one calls
`createSavepoint` until lamina-style external savepoints, by which time
SELECT's iterator is already established against the immutable
committed layer), so this bug was latent.

**Fix B:** In `MemoryTableConnection.createSavepoint`, do not create a
fresh pending layer if none exists. Push `null` onto `savepointStack`
to mark "no pending at create time". `rollbackToSavepoint` recognises
the `null` marker and restores `pendingTransactionLayer = null` instead
of cloning. `releaseSavepoint` also drops its `if
(!this.pendingTransactionLayer) return` early-out so stmt savepoint
releases on idle connections truncate the stack as expected.

## Why both fixes are required together

- **Broadcast only** → bug B regresses `01.5-insert-select.sqllogic`.
- **Lazy-snapshot only** → bug A still fails (release isn't broadcast, so
  the registerConnection replay's empty placeholder stays at depth 0).

Both fixes were independently verified by running
`yarn workspace @quereus/quereus run test` — all 3175 quereus tests
pass with both applied (the one isolation-package failure,
`DROP INDEX … inside an active transaction`, is pre-existing on
`fd` and unrelated).

## Out-of-scope follow-ups

- `runUpdate` / `runDelete` in the same file may want the same wrap if
  ABORT semantics matter for multi-row UPDATEs and the underlying vtab
  doesn't already snapshot itself. Not addressed here — file a separate
  ticket if a failing test surfaces.
- The pre-existing `IsolationModule … DROP INDEX inside an active
  transaction` failure in `packages/quereus-isolation/test/isolation-layer.spec.ts:1111`
  exists on `fd` independent of this work. Out of scope.

## TODO

- In `packages/quereus/src/runtime/emit/dml-executor.ts`:
  - Restore the module-scope `stmtSavepointCounter` (used to generate
    unique `__or_abort_N` names across concurrent emissions).
  - Wrap the existing `for await` in `runInsert` with a statement-scope
    savepoint when `plan.onConflict !== ConflictResolution.FAIL`. Pattern
    (mirrors `runtime/emit/transaction.ts:71-89, 95-110, 38-53`):

    ```ts
    const wrapStatementSavepoint = !isFailMode;
    const stmtSavepointName = wrapStatementSavepoint
        ? `__or_abort_${stmtSavepointCounter++}`
        : undefined;
    if (stmtSavepointName) {
        const depth = ctx.db._createSavepoint(stmtSavepointName);
        for (const connection of ctx.db.getAllConnections()) {
            await connection.createSavepoint(depth);
        }
    }
    try {
        try {
            for await (const flatRow of rows) { /* existing body */ }
            if (stmtSavepointName) {
                const depth = ctx.db._releaseSavepoint(stmtSavepointName);
                for (const connection of ctx.db.getAllConnections()) {
                    await connection.releaseSavepoint(depth);
                }
            }
        } catch (e) {
            if (stmtSavepointName) {
                try {
                    const depth = ctx.db._rollbackToSavepoint(stmtSavepointName);
                    for (const connection of ctx.db.getAllConnections()) {
                        await connection.rollbackToSavepoint(depth);
                    }
                } catch { /* swallow */ }
                try {
                    const depth = ctx.db._releaseSavepoint(stmtSavepointName);
                    for (const connection of ctx.db.getAllConnections()) {
                        await connection.releaseSavepoint(depth);
                    }
                } catch { /* swallow */ }
            }
            throw e;
        }
    } finally {
        await disconnectVTable(ctx, vtab);
    }
    ```

    The inner double-try (release in success path, rollback+release in
    catch) keeps the failing path symmetric with `transaction.ts`. The
    existing FAIL-mode per-row savepoint stays nested unchanged.

- In `packages/quereus/src/vtab/memory/layer/connection.ts`:
  - Change `savepointStack` type to `Array<TransactionLayer | null>`.
  - In `createSavepoint(depth)`: drop the eager
    `if (!this.pendingTransactionLayer) { this.pendingTransactionLayer = new TransactionLayer(...) }`.
    Push the snapshot **or `null`** when no pending layer exists:

    ```ts
    const savepointLayer = this.pendingTransactionLayer
        ? this.createTransactionSnapshot(this.pendingTransactionLayer)
        : null;
    this.savepointStack.push(savepointLayer);
    this.explicitTransaction = true;
    ```

  - In `rollbackToSavepoint(targetDepth)`: drop the `if
    (!this.pendingTransactionLayer) return` guard. Branch on
    `savepoint === null`:
    ```ts
    if (savepoint === null) {
        this.pendingTransactionLayer = null;
    } else {
        this.pendingTransactionLayer = new TransactionLayer(savepoint);
        if (savepoint.isTrackingChanges()) {
            this.pendingTransactionLayer.enableChangeTracking();
        }
    }
    ```
  - In `releaseSavepoint(targetDepth)`: drop the `if
    (!this.pendingTransactionLayer) return` early-out. Just truncate:
    `this.savepointStack.length = targetDepth;`. (A stmt savepoint
    release that fires on a connection whose `pendingTransactionLayer`
    is still `null` must still pop its placeholder.)
  - Add a short comment on `savepointStack` explaining the null marker.

- Validate:
  - `node test-runner.mjs --reporter=spec -g "95-assertions|01.5-insert-select"`
    (both must pass).
  - `yarn workspace @quereus/quereus run test` (3175 passing).
  - Do **not** run `yarn test` at repo root expecting green — the
    pre-existing `IsolationModule … DROP INDEX inside an active
    transaction` failure on `fd` is unrelated; verify the failure list
    is unchanged.
