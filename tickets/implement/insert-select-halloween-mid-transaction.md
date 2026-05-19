---
description: Self-referential `INSERT ... SELECT` from the same table re-reads its own writes when the connection has a non-empty `pendingTransactionLayer` at savepoint time (mid-transaction, after prior writes in the same explicit transaction). The autocommit case is fine because the lazy-snapshot path leaves `pendingTransactionLayer = null` at SELECT start, so the SELECT iterates `readLayer.primary` while the INSERT writes into a freshly-created child layer's separate BTree. The mid-transaction case takes the eager branch in `MemoryTableConnection.createSavepoint`, which clones the pending layer onto the savepoint stack but does NOT swap `pendingTransactionLayer` — so SELECT and INSERT iterate/mutate the same BTree. Fix: make the eager branch mirror the autocommit-path invariant by snapshotting the pending layer, swapping it onto `readLayer`, and clearing `pendingTransactionLayer` so the next mutation creates a fresh child layer parented on the (now immutable) snapshot.
files:
  - packages/quereus/src/vtab/memory/layer/connection.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/vtab/memory/table.ts
  - packages/quereus/test/logic/01.5-insert-select.sqllogic
---

# Mid-transaction self-referential INSERT...SELECT halloween fix

## Background

The `dml-executor-statement-savepoint-broadcast` change made `MemoryTableConnection.createSavepoint` lazy when `pendingTransactionLayer` is null: it pushes a `null` marker so the next mutation creates a fresh pending layer parented on `currentCommittedLayer`. That keeps the autocommit self-ref INSERT...SELECT safe — `query()` captures `startLayer = pending ?? readLayer = readLayer` BEFORE the first INSERT runs `ensureTransactionLayer`, so the SELECT iterator walks `readLayer.primary` while writes mutate a *different* BTree (the new pending's child tree, with `readLayer.primary` as its inheritree base).

The mid-transaction path doesn't get the same protection. When `pendingTransactionLayer` is non-null at savepoint time, `createSavepoint` takes the eager branch:

```ts
const savepointLayer = this.pendingTransactionLayer
    ? this.createTransactionSnapshot(this.pendingTransactionLayer)
    : null;
this.savepointStack.push(savepointLayer);
```

The snapshot goes onto the stack but `pendingTransactionLayer` still references the original mutable layer. `MemoryTable.query()` then captures `startLayer = pendingTransactionLayer`, and `processInsertRow` mutates the very same layer's primary tree — halloween. The runaway integer (`val * 2` doubling row by row until `Number.isSafeInteger` rejects it) is just the visible symptom; any self-referential INSERT...SELECT in this position will see its own writes.

## Repro (canonical)

```sql
create table t (id integer primary key, val integer);
begin;
insert into t values (1, 10), (2, 20);
insert into t (id, val) select id + 100, val * 2 from t;  -- explodes
commit;
```

Expected rows: `(1,10),(2,20),(101,20),(102,40)`. Same as `test/logic/01.5-insert-select.sqllogic` test 7, but wrapped in `BEGIN...COMMIT` with a seeding `INSERT VALUES` so the connection's `pendingTransactionLayer` is non-null when the self-ref INSERT runs.

## Fix approach (chosen)

Make the eager branch establish the same "SELECT and INSERT touch different BTrees" invariant that the lazy branch already provides. Specifically, at savepoint creation when `pendingTransactionLayer` is non-null:

1. Build an immutable snapshot of the pending layer (existing `createTransactionSnapshot`). Its parent is the original pending's parent, so the committed chain stays valid.
2. Push the snapshot onto `savepointStack` (unchanged).
3. **Swap**: set `connection.readLayer = snapshot` and `connection.pendingTransactionLayer = null`.

Then `MemoryTable.query()` captures `startLayer = pending ?? readLayer = readLayer = snapshot` (immutable). The first mutation calls `ensureTransactionLayer`, which must now parent the new pending on `connection.readLayer` (the snapshot) instead of `this._currentCommittedLayer` — so prior in-transaction writes remain visible. Writes go into the new pending's primary tree, which is a different BTree object from `snapshot.primary` (it uses `snapshot.primary` as its inheritree base via copy-on-write). The SELECT iterator walks `snapshot.primary` and never sees the new writes. Same invariant as the autocommit case.

### Why this is correct

- **Read-your-own-writes within the transaction**: `snapshot` is a full copy of the prior pending's effective data (including all in-transaction writes up to the savepoint), and the new pending inherits from it. Subsequent statements still see everything.
- **Commit chain**: at commit, the parent chain is `newPending → snapshot → originalParent` where `originalParent` was `currentCommittedLayer` (or an earlier savepoint snapshot, if savepoints stack). `commitTransaction`'s parent walk finds `currentCommittedLayer` and succeeds. `tryCollapseLayers` will eventually flatten the snapshot into the chain.
- **Rollback semantics**: `rollbackToSavepoint` must mirror the swap — restore `connection.readLayer = savepoint` and `connection.pendingTransactionLayer = null` (instead of `new TransactionLayer(savepoint)`). Subsequent mutations will lazily create a new pending parented on `readLayer = savepoint`.
- **Lazy-marker case unchanged**: when the savepoint slot is `null`, no `readLayer` swap happened at savepoint creation; rollback just clears `pendingTransactionLayer` (existing behavior).

### Why the alternatives lose

- **Snapshot-at-query-start in `MemoryTable.query()`**: doubles snapshot cost on every read, including reads that have no concurrent writes. Surgical but wasteful.
- **BTree path-snapshot iteration in `scan-layer.ts`**: most "real-database" but introduces a cross-cutting change to how every memory-module scan handles concurrent mutation, with risk of breaking other invariants (cursor stability for non-halloween cases is already handled by `safeIterate`).

The chosen approach piggybacks on the same `createTransactionSnapshot` cost the existing eager branch already pays — net cost is one extra layer object (the new empty pending) per statement savepoint with prior writes. Same memory profile as before.

## Change-tracking note (pre-existing, not addressed here)

`createTransactionSnapshot` already calls `snapshotLayer.copyChangeTrackingFrom(sourceLayer)` to transfer pending events onto the savepoint snapshot. With the swap, those events live on `snapshot`, while new writes' events go on the new pending. On commit, only the new pending's events are emitted (`pendingLayer.getPendingChanges()`), so the snapshot's events would be lost.

This is a pre-existing concern with the same eager-snapshot code path: the current `rollbackToSavepoint` ALREADY creates `new TransactionLayer(savepoint)` and lets writes accumulate on the new layer, so events from before the most-recent savepoint are already orphaned on commit. The fix here doesn't worsen that. Track it as a follow-up if real users hit it; tag in the review handoff.

## Other backends

- **`packages/quereus-isolation`**: the isolation overlay uses a `MemoryTable` overlay under the hood (see `isolated-table.ts:153`, `ensureOverlay`). The fix in `MemoryTableConnection` automatically benefits the isolation overlay. No isolation-specific change needed.
- **`packages/quereus-store`**: uses a different model — an operation log committed atomically (`packages/quereus-store/src/common/transaction.ts:178`). Reads go to the underlying KV store; pending writes are buffered in `pendingOps` and not visible to reads mid-transaction. The halloween shape would manifest only if a self-ref `INSERT ... SELECT` could observe writes from the same statement, which the operation-log buffering rules out. **Confirm during implementation by running `yarn test:store` after the memory fix lands** — if a store-equivalent of the new sqllogic test passes, no store-side change needed.

## Implementation TODO

- Edit `packages/quereus/src/vtab/memory/layer/connection.ts`:
  - In `createSavepoint`: keep the lazy-`null` marker for the `pending === null` case. In the non-null branch, after pushing the snapshot, set `this.readLayer = snapshot` and `this.pendingTransactionLayer = null`.
  - Update the doc comment on `savepointStack` to describe the swap behavior (not just lazy-snapshot).
  - In `rollbackToSavepoint`: when the savepoint slot is non-null, replace the `pendingTransactionLayer = new TransactionLayer(savepoint)` line with `this.readLayer = savepoint; this.pendingTransactionLayer = null;`. Drop the `enableChangeTracking()` copy (the snapshot already has it). The new pending will be re-created lazily on the next mutation.
  - In `rollback()` (full transaction rollback): no change needed — it already sets `readLayer = currentCommittedLayer` and `pendingTransactionLayer = null`.
- Edit `packages/quereus/src/vtab/memory/layer/manager.ts`:
  - In `ensureTransactionLayer`: change parent from `this._currentCommittedLayer` to `connection.readLayer`. Verify all call sites of this method work with the new parent (the only call site is `performMutation`, which is fine). In the clean autocommit case, `connection.readLayer === this._currentCommittedLayer` so behavior is unchanged.
- Add a sqllogic test block to `packages/quereus/test/logic/01.5-insert-select.sqllogic` immediately after section 7 (the canonical doubler test). Name it section 7b or 9 — something like "INSERT ... SELECT self-referential mid-transaction (after prior writes)". Wrap the doubler scenario in `begin; ... commit;` and seed with `insert into t values (1, 10), (2, 20);` before the self-ref. Expected: `[{"id":1,"val":10},{"id":2,"val":20},{"id":101,"val":20},{"id":102,"val":40}]`.
- Run `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/halloween-test.log; tail -n 60 /tmp/halloween-test.log` to confirm the new test passes and nothing else regresses. Pay special attention to `04a-savepoint-lazy-attach.sqllogic`, `04-transactions.sqllogic`, and any savepoint-related test.
- Run `yarn workspace @quereus/quereus run lint`.
- Optional but recommended: `yarn test:store 2>&1 | tee /tmp/halloween-store.log; tail -n 60 /tmp/halloween-store.log` to verify store-backed sqllogic tests pass (this confirms the store backend doesn't have a parallel halloween bug). If it fails on the new test specifically, file a follow-up `fix/` ticket and exclude store from the new block (or note the deferral in the review handoff).
- In the review handoff, call out the pre-existing change-tracking concern (events from before the most-recent eager-snapshot savepoint are orphaned on commit) as a known limitation worth its own ticket if anyone subscribes to event emissions across savepoints.
