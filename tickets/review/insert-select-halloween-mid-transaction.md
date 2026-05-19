---
description: Mid-transaction self-referential `INSERT ... SELECT` no longer re-reads its own writes. Implementation took the "swap" approach from the fix ticket (readLayer ← snapshot, pending ← null) but with three structural deviations from the original plan, all forced by failures the plan didn't anticipate. (1) `createTransactionSnapshot`'s data-copy approach drops deletions of inherited rows, so the eager savepoint snapshot is now the **promoted** pending layer itself (`markCommitted()`-protected, reused in place). (2) `savepointStack` slot type changed from `TransactionLayer | null` to `{ snapshot, readLayer }` so rollback to a lazy marker can also restore the pre-swap readLayer. (3) `commitTransaction` now walks the parent chain to collect events from savepoint-promoted in-transaction layers, otherwise events from writes before any eager-swap are lost. Plus surrounding plumbing: `ensureConnection`'s readLayer reset is now gated on no-active-transaction; `commit`/`rollback` always clear transaction state (the broadcast hits every connection regardless of work); a lazy-pending step in `commitTransaction` promotes the snapshot's data into the committed chain when no further mutations followed the savepoint; and `ensureTransactionLayer` now parents new pending layers on `connection.readLayer` instead of `_currentCommittedLayer`. Use cases for review: the canonical halloween repro (section 7b in `01.5-insert-select.sqllogic`), the nested-savepoint and ROLLBACK-TO tests in `04-transactions.sqllogic` and `04a-savepoint-lazy-attach.sqllogic`, transactional DELETE-then-INSERT on singleton (empty-PK) tables in `12-empty-primary-key.sqllogic`, ALTER TABLE ADD COLUMN after prior in-transaction writes (`105-vtab-memory-mutation-kills.sqllogic`), and event batching across SAVEPOINT in `vtab-events.spec.ts`.
files:
  - packages/quereus/src/vtab/memory/layer/connection.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/vtab/memory/table.ts
  - packages/quereus/test/logic/01.5-insert-select.sqllogic
---

# Review: mid-transaction self-referential INSERT...SELECT halloween fix

## What changed and why

The plan in the implement ticket was straightforward: at savepoint creation with a non-null pending layer, snapshot the pending, **swap** `readLayer` to point at the snapshot, and clear `pendingTransactionLayer`. That keeps SELECT iterators reading an immutable BTree while INSERTs write to a separate copy-on-write child. The fix had to deviate from the plan in three places that the plan didn't anticipate but the test suite exposed.

### Deviation 1 — promote instead of copy (`connection.ts:createSavepoint`)

The original `createTransactionSnapshot` was data-copying: it built a fresh `TransactionLayer` parented on `sourceLayer.getParent()` and walked `sourceLayer.primary.ascending(first)` calling `recordUpsert` on the new layer. With the **swap**, the snapshot becomes the `readLayer` for the rest of the transaction — and the data-copy approach silently drops deletions of inherited rows:

- Singleton table with PK `()` has one committed row `(app_theme, light)` in P_init.
- `BEGIN; DELETE FROM t;` — P_del.primary clones the inherited leaf and splices out the entry.
- `INSERT INTO t VALUES (temp_config, ...)` — stmt-savepoint fires `createSavepoint`, which calls `createTransactionSnapshot(P_del)`. The copy iterates P_del.primary.ascending → yields 0 rows (the cloned leaf is empty). No `recordUpsert` calls. The new snapshot has no local entries, so its primary tree falls through to its `base` = P_init.primary, which still has the original `(app_theme, light)`. SELECT/INSERT see the row again, and the INSERT trips the UNIQUE constraint.

`12-empty-primary-key.sqllogic` test 11 caught this.

Fix: drop `createTransactionSnapshot` entirely. The eager branch now **promotes** the existing pending layer — `snapshot.markCommitted()` to lock it against future mutation — and reuses it in place. This preserves the BTree's actual COW structure (including the cloned-and-spliced leaf representing the delete). The new pending parents on the promoted layer; reads see the promoted layer's effective state directly; writes go to a fresh COW child.

### Deviation 2 — savepointStack slot stores `{ snapshot, readLayer }` (`connection.ts:savepointStack`)

The original plan kept the savepoint stack as `Array<TransactionLayer | null>` and described "rollback to a lazy marker restores the no-pending state." That works when no eager swap happened in between — but nested savepoints can interleave:

- `SAVEPOINT outer` (lazy, pending=null at the time)
- `INSERT ...` (creates pending P1)
- `SAVEPOINT inner` (eager — swaps readLayer to P1, pending=null)
- `INSERT ...` (creates pending P2 parented on promoted-P1)
- `ROLLBACK TO outer` — the slot at depth 0 is a `null` marker. Just clearing pending leaves `readLayer = promoted-P1`, so the SELECT after rollback sees P1's data even though the user expected pre-INSERT state.

`04a-savepoint-lazy-attach.sqllogic` case 3 (well, the nested-savepoint shape generally) catches this.

Fix: the stack slot stores both `snapshot` and the `readLayer` value at savepoint creation. Lazy rollback restores the saved `readLayer`; eager rollback restores `entry.snapshot` (which is also where readLayer was swapped to). Both branches clear `pending` since any in-transaction writes after the savepoint are by definition above it in the stack.

### Deviation 3 — commit must walk ancestor TransactionLayers for events (`manager.ts:commitTransaction`)

Statement-level savepoints in `dml-executor` wrap **every** non-FAIL DML statement in a `__or_abort_N` savepoint that fires `createSavepoint` on every active connection. After the first INSERT in a transaction (which creates a pending P1), the next DML statement's stmt-savepoint hits the eager branch — which now promotes P1 and creates a fresh P2 for the next write. P1 keeps its `pendingChanges` but is no longer the connection's pending layer, so `pendingLayer.getPendingChanges()` (the previous source for event emission) drops P1's events.

`vtab-events.spec.ts`'s "should batch events until explicit COMMIT" caught this: a transaction with two INSERTs only emitted one event (the second), because the first lived on P1 which got promoted between statements.

Fix: at commit time, walk `pending.parent` upward to `_currentCommittedLayer`, collecting `getPendingChanges()` from each `TransactionLayer` in the chain. Chunks are accumulated newest-first and reversed (chunk-level, preserving intra-chunk order) before flattening, so chronological order matches what the user wrote.

This addresses the change-tracking concern the implement ticket flagged as "pre-existing, not worsened." It WAS worsened by the swap — every stmt-savepoint mid-transaction created an event-orphaning swap — so the fix had to land alongside.

### Surrounding plumbing

These weren't deviations from the plan; they're bookkeeping the swap forced.

- **`ensureConnection` readLayer reset is gated** (`table.ts:96`). The pre-existing line `this.connection.readLayer = this.manager.currentCommittedLayer;` runs when `getVTable` doesn't get a chance to inject (e.g., `runtime/emit/scan.ts` calls `module.connect` directly and skips the inject branch). Unconditional reset clobbered `readLayer` set by the swap. The reset is now skipped when the connection has `pendingTransactionLayer` or `explicitTransaction === true`; schema changes throw on active transactions so the staleness this reset was originally guarding against can't happen during a transaction anyway.
- **`commit()` and `rollback()` always call `clearTransactionState()`** (`connection.ts:67-102`). `_finalizeImplicitTransaction` broadcasts commit/rollback to every registered connection regardless of whether the connection had work to do. The old early-return-on-empty-state path left `explicitTransaction` stuck at `true` (`begin` always sets it, even for implicit transactions), which kept the next autocommit statement's `ensureConnection` from refreshing readLayer.
- **`commitTransaction` lazy-pending when readLayer is "ahead"** (`manager.ts:247-275`). If user does `BEGIN; INSERT; SAVEPOINT sp; ROLLBACK TO sp; COMMIT;`, after the rollback `pending = null` but `readLayer = promoted P1` (with the insert's data). The old commit early-returned on `!pending`, losing the data. The new path wraps an empty pending around `readLayer` and commits it — but only when readLayer is **ahead** of the committed chain (its parent chain leads to `_currentCommittedLayer`) **and** its schema matches `this.tableSchema`. The schema check filters out the case where ALTER TABLE consolidated everything into baseLayer and our connection's readLayer is a now-stale ancestor (`105-vtab-memory-mutation-kills.sqllogic` case caught this — committing the stale TransactionLayer supplanted the schema-updated baseLayer as head).
- **`ensureTransactionLayer` parents on `connection.readLayer`** (`manager.ts:530`). The new pending must inherit the promoted savepoint's data, not the committed-chain head. In the clean autocommit case the two are equal so behavior is unchanged.

## Test plan / what to exercise

The new sqllogic test (`01.5-insert-select.sqllogic` section 7b) is the **floor**, not the ceiling — the implementation touches enough state machinery that several existing tests caught regressions:

- **Canonical halloween mid-transaction**: section 7b in `01.5-insert-select.sqllogic`. Same shape as section 7 but wrapped in `BEGIN ... COMMIT` with a seeding `INSERT VALUES`. Expected `[(1,10),(2,20),(101,20),(102,40)]`. Without the swap, val keeps doubling until `Number.isSafeInteger` rejects it.
- **Nested savepoints + ROLLBACK TO**: `04-transactions.sqllogic` "Nested Savepoints" (line 116) and "Nested savepoints unwinding correctly" (line 207). Exercises the `{snapshot, readLayer}` slot for lazy markers nested under eager swaps.
- **Lazy-attach savepoints**: `04a-savepoint-lazy-attach.sqllogic` cases 2 (nested before any access), 3 (prior committed write + nested rollbacks), 4 (SELECT before SAVEPOINT). All four cases must still pass.
- **DELETE-then-INSERT in transaction on singleton table**: `12-empty-primary-key.sqllogic` test 11. Catches the data-copy snapshot's inherited-deletion bug.
- **ALTER TABLE ADD COLUMN after prior in-transaction writes**: `105-vtab-memory-mutation-kills.sqllogic` test 8. Catches the lazy-pending-on-commit propagating a stale-schema layer.
- **Event batching across SAVEPOINT in a transaction**: `vtab-events.spec.ts` "should batch events until explicit COMMIT" (line 73). Catches the events-lost-on-promotion bug.
- **`core-api-transactions.spec.ts` Savepoints via SQL** suite, especially "rollback to savepoint discards changes but keeps earlier ones" (line 186) — caught the `ensureConnection` readLayer-reset clobbering the swap.

## Validation run

`yarn workspace @quereus/quereus run test` — 3175 passing, 0 failing.
`yarn workspace @quereus/quereus run lint` — clean.
`yarn test:store` — 3171 passing, 4 pending (pending count matches main branch). The new section 7b also passes against the store backend.

## Known gaps / things the reviewer should look at twice

- **`createTransactionSnapshot` removal**: I deleted the method outright since the eager branch now promotes in-place. No other call sites existed in the workspace at the time. Double-check that no caller depends on the old data-copy semantics (independent layer with copied rows) — `Grep` for `createTransactionSnapshot` returned only the now-deleted definition during implementation, but reviewer should verify.
- **Cross-connection commit semantics**: the new lazy-pending-on-commit + the chain-walk-for-events combine to commit ancestor TransactionLayers that the committing connection didn't own as "pending." Within a single-connection-per-table flow (what the tests cover), this is correct. With multiple connections committing to the same table concurrently, ancestor layers in our chain might be from a different connection's savepoint, and walking them for events could double-emit. I don't see a test exercising that, and the `_inCoordinatedCommit()` branch already permits sibling-style commits. Worth a careful read.
- **`commit()` always calls `clearTransactionState()`**: this clears `savepointStack` AND sets `explicitTransaction = false`. If a hypothetical caller calls `commit()` mid-savepoint-stack (i.e., not via the DB's broadcast — directly on the connection), the stack would silently disappear. I don't see such a caller in the workspace; the only call to `MemoryTableConnection.commit()` is via `MemoryVirtualTableConnection.commit()` which is broadcast-driven.
- **Promote vs copy memory tradeoff**: the old copy approach allocated a fresh BTree and replayed all rows. Promote skips both, but holds onto the old pending layer in the savepoint stack until release/rollback. For long-running transactions with many savepoints, this means many promoted layers in memory simultaneously. Probably fine — the original code also held data-copy snapshots in the stack, so total memory is comparable or better — but worth flagging.
- **No `disconnect`-defer change**: I considered making `manager.disconnect` also defer when `explicitTransaction === true` (not just `pending !== null`), since after the eager swap `pending` is null but the connection is still mid-transaction. The current code path works without that change because `getVTable` uses `setConnection` to inject before `ensureConnection` runs, bypassing the readLayer-reset branch entirely. The `scan.ts` path that **does** call `module.connect` directly is fine because `ensureConnection`'s reset is now gated on `!explicitTransaction && !pending`. Worth verifying the gating logic catches all the paths.
- **Other backends**: `quereus-isolation` rides on `MemoryTable` overlay and benefits automatically. `quereus-store` uses a separate operation-log model and runs the full sqllogic suite cleanly (`yarn test:store`).
