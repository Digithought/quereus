---
description: Secondary index operations now route through TransactionCoordinator during transactions
dependencies: packages/quereus-store/src/common/transaction.ts, packages/quereus-store/src/common/store-table.ts
files:
  - packages/quereus-store/src/common/transaction.ts
  - packages/quereus-store/src/common/store-table.ts
  - packages/quereus-store/test/transaction.spec.ts
---

# Fix: Secondary Index Updates Bypass TransactionCoordinator

## Summary

Secondary index writes (delete old entry, put new entry) in `StoreTable.updateSecondaryIndexes()` were applied directly to the index store even inside transactions, bypassing the `TransactionCoordinator`. This meant index mutations were **not rolled back** when transactions were rolled back, causing data inconsistency between data and index stores.

## Changes

### TransactionCoordinator (`transaction.ts`)

- Added optional `store` field to `PendingOp` interface, allowing operations to target stores other than the default
- Extended `put()` and `delete()` to accept an optional `store?: KVStore` parameter
- Updated `commit()` to group pending operations by target store and write a separate batch per store (instead of writing all ops to a single store's batch)

### StoreTable (`store-table.ts`)

- In `updateSecondaryIndexes()`, the `inTransaction` branches now route through the coordinator with the index store as the target: `this.coordinator.delete(key, indexStore)` / `this.coordinator.put(key, value, indexStore)`
- The non-transaction branches remain unchanged (direct store writes)
- Eliminates the DRY violation where both branches had identical code

## Testing

4 new tests in `transaction.spec.ts` under "multi-store operations":
- **commit writes to both default and explicit stores** — verifies ops target the correct store with no cross-contamination
- **rollback discards operations on all stores** — verifies rollback clears ops on all targeted stores
- **delete targets the explicit store** — verifies store-targeted deletes
- **savepoint rollback discards multi-store ops after savepoint** — verifies savepoint rollback works for multi-store ops

## Validation

- `yarn workspace @quereus/store build` — passes
- `yarn workspace @quereus/store test` — 133 passing (including 4 new)
- `yarn build` — full project builds clean
- `yarn test` — all project tests pass
