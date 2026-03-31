description: Deduplicated planAppliesToKey and scan logic across base-cursor, transaction-cursor, and manager
dependencies: none
files:
  packages/quereus/src/vtab/memory/layer/plan-filter.ts (new)
  packages/quereus/src/vtab/memory/layer/scan-layer.ts (new)
  packages/quereus/src/vtab/memory/layer/interface.ts (modified)
  packages/quereus/src/vtab/memory/layer/manager.ts (modified)
  packages/quereus/src/vtab/memory/layer/base-cursor.ts (deleted)
  packages/quereus/src/vtab/memory/layer/transaction-cursor.ts (deleted)
----
## What was done

### planAppliesToKey extraction (`plan-filter.ts`)
Extracted `planAppliesToKey` into a shared utility. The three prior implementations (base-cursor closure, transaction-cursor closure, manager public method) all checked equality, prefix-range, and bound constraints with near-identical logic. The unified version takes `(plan, key, keyComparator)` and handles all cases.

Key fix: changed `plan.equalityKey !== undefined` to `plan.equalityKey != null` — the old transaction-cursor used a truthy check (`if (plan.equalityKey)`) which treated `null` as falsy, skipping equality matching. The old base-cursor used `!== undefined` which would enter equality matching for `null` keys. The FK system can pass `equalityKey: null` when validating NULL FK values; the `!= null` guard correctly skips equality matching for both `null` and `undefined`.

### Unified scan (`scan-layer.ts`)
Merged `scanBaseLayer` and `scanTransactionLayer` into a single `scanLayer` generator that operates on the `Layer` interface. Both functions were ~95% structurally identical — multi-seek dispatch, multi-range dispatch, primary scan with early termination, secondary index scan with early termination. With inherited BTrees, the transaction cursor no longer needed layer-specific logic.

Key changes vs. the old split:
- Uses `Layer` interface methods (`getModificationTree`, `getSecondaryIndexTree`, `getPkExtractorsAndComparators`) instead of layer-specific properties
- Removed the unused `_parentIterable` parameter (artifact of pre-inheritree design)
- Gets `primaryTree` once before the secondary index iteration loop (old transaction-cursor re-fetched it per entry)
- Gets `isDescFirstColumn` from the schema (works for both layer types) instead of `secondaryIndex.specColumns[0]?.desc`
- Removed `any` casts from the old transaction-cursor's comparator resolution

### Interface cleanup
- Made `getSecondaryIndexTree` required on the `Layer` interface (both BaseLayer and TransactionLayer already implemented it)

### Manager cleanup
- Removed the unused `planAppliesToKey` public method (never called externally)
- Removed `BTreeKey` and `IndexConstraintOp` imports (only used by the removed method)
- Simplified `scanLayer` to delegate directly to the unified implementation

## Testing notes
- All 1013 quereus tests pass (same as baseline)
- All workspace tests pass (121 additional)
- The null `equalityKey` edge case is exercised by `41-foreign-keys.sqllogic` (SET NULL ON DELETE scenarios)
- Key test areas: FK cascades, index scans, range scans, prefix-range scans, DESC index scans, multi-seek, multi-range
