description: Deduplicate planAppliesToKey and scan logic across base-cursor, transaction-cursor, and manager
dependencies: none
files:
  packages/quereus/src/vtab/memory/layer/base-cursor.ts
  packages/quereus/src/vtab/memory/layer/transaction-cursor.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
----
## Problem

`planAppliesToKey` is implemented three times with nearly identical logic:
- `base-cursor.ts:40` (local closure)
- `transaction-cursor.ts:41` (local closure)
- `manager.ts:932` (public method)

Beyond that, `scanBaseLayer` and `scanTransactionLayer` are ~95% structurally identical: multi-seek dispatch, multi-range dispatch, primary scan with early termination, secondary index scan with early termination. With inherited BTrees, the transaction cursor no longer needs to merge parent data — it scans the inherited BTree directly, same as the base cursor.

## Proposed Approach

- Extract `planAppliesToKey` into a shared utility in the layer directory (e.g., `plan-filter.ts`)
- Unify `scanBaseLayer` and `scanTransactionLayer` into a single `scanLayer` generator that operates on the `Layer` interface, since both now just scan BTrees via `getModificationTree` / `getSecondaryIndexTree`
- Remove the unused `_parentIterable` parameter from `scanTransactionLayer` (or from the unified function)
- The manager's `planAppliesToKey` can delegate to the shared utility

## Notes

- `transaction-cursor.ts:47` uses `any` casts for the comparator — the unified version should use proper types
- The `_parentIterable` parameter in `scanTransactionLayer` is dead (prefixed `_`, never read) — artifact of pre-inheritree design
