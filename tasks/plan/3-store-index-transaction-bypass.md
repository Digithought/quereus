---
description: Fix StoreTable secondary index updates bypassing TransactionCoordinator during transactions
dependencies: packages/quereus-store/src/common/store-table.ts, packages/quereus-store/src/common/transaction.ts

---

# Secondary Index Updates Bypass Transaction Coordinator

## Problem

In `StoreTable.updateSecondaryIndexes()`, secondary index writes (delete old entry, put new entry) are applied directly to the index store even when inside a transaction. The `if/else` branches for `inTransaction` vs not are identical — both call `indexStore.delete()` / `indexStore.put()` directly, bypassing the `TransactionCoordinator`.

This means index mutations are **not rolled back** when the transaction is rolled back, causing data inconsistency between the data store and index stores.

## Location

`packages/quereus-store/src/common/store-table.ts`, lines 589–611.

```typescript
if (inTransaction && this.coordinator) {
  // For transactions, we need to track index operations separately
  // For now, apply directly (transaction support for indexes is TODO)
  await indexStore.delete(oldIndexKey);
} else {
  await indexStore.delete(oldIndexKey);
}
```

Both branches do exactly the same thing. The `inTransaction` branch should route through the coordinator so that index ops are included in the transaction's pending operations.

## DRY Violation

The `if/else` is a DRY violation — both branches have identical code. Once fixed, the transaction branch should use coordinator methods while the non-transaction branch applies directly, giving each branch distinct behavior.

## Fix Approach

When `inTransaction && this.coordinator`, use the coordinator to track index operations:

```typescript
if (inTransaction && this.coordinator) {
  this.coordinator.delete(indexStore, oldIndexKey);
} else {
  await indexStore.delete(oldIndexKey);
}
```

This requires verifying that `TransactionCoordinator.delete()` and `.put()` can accept arbitrary stores (not just the table's data store). If the coordinator is currently tied to a single store, it may need to be extended to support multi-store transactions, or a per-index coordinator approach may be needed.

## TODO

- [ ] Route index delete/put through the coordinator when in a transaction
- [ ] Ensure coordinator supports operations on multiple stores (data + index stores)
- [ ] Add tests verifying index consistency after transaction rollback
- [ ] Remove the DRY violation (each branch should have distinct behavior)

