---
description: Extended MemoryTable getBestAccessPlan to handle IS NULL, IS NOT NULL, and multi-value IN constraint operators
dependencies: none
---

# Extended Constraint Pushdown for MemoryTable — Review

## Summary

Extended the MemoryTable access planning to handle three new constraint types beyond the existing equality (`=`) and range (`<`, `<=`, `>`, `>=`):

### IS NULL / IS NOT NULL (nullability-aware planning)
- **IS NULL on NOT NULL column**: Detected as impossible — returns zero-cost empty result plan with all filters marked handled
- **IS NOT NULL on NOT NULL column**: Detected as trivially true — marked as handled without changing the plan
- **IS NULL / IS NOT NULL on nullable columns**: Left unhandled (residual filter), as the BTree doesn't provide a NULL-specific index path

### Multi-value IN (index multi-seek)
- `findEqualityMatches` now accepts multi-value IN as an equality match for prefix matching purposes, tracking cardinality (product of all IN list sizes)
- `evaluateIndexAccess` uses the IN cardinality for cost estimation (cost = N * single-lookup cost)
- New plan type 5 ("multi-seek") added to the scan plan system
- `ScanPlan` extended with `equalityKeys?: BTreeKey[]` for multi-key lookups
- Both `scanBaseLayer` and `scanTransactionLayer` handle `equalityKeys` by recursing with individual equality plans
- `selectPhysicalNodeFromPlan` in the access path rule creates proper IndexSeekNode with all IN values as seek keys

## Files Changed

- `packages/quereus/src/vtab/memory/module.ts` — Added `handleNullConstraints` pre-pass; updated `findEqualityMatches` to accept multi-value IN with cardinality tracking; updated `evaluateIndexAccess` cost model for IN
- `packages/quereus/src/vtab/memory/layer/scan-plan.ts` — Added `equalityKeys` field to `ScanPlan`; added plan type 5 handling in `buildScanPlanFromFilterInfo`
- `packages/quereus/src/vtab/memory/layer/base-cursor.ts` — Multi-seek dispatch for `equalityKeys`
- `packages/quereus/src/vtab/memory/layer/transaction-cursor.ts` — Multi-seek dispatch for `equalityKeys`
- `packages/quereus/src/planner/rules/access/rule-select-access-path.ts` — Multi-value IN detection and IndexSeekNode construction with plan type 5

## Testing

- `packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts` — 12 tests covering:
  - IS NULL on PK / NOT NULL columns (empty result)
  - IS NOT NULL on PK / NOT NULL columns (all rows)
  - IS NULL / IS NOT NULL on nullable columns (correct filtering)
  - IN on PK with multiple values (correct multi-seek)
  - Single-value IN (backward compatibility)
  - IN with no matching values (empty result)
  - IN combined with other WHERE predicates
  - IS NULL + other filters combined
  - IS NOT NULL + IN combined

## Validation
- All 684 existing tests pass
- All 12 new tests pass
- Build compiles cleanly

## Scope Limitations
- Multi-value IN only supports single-column index seeks (composite index IN not implemented)
- IS NULL on nullable indexed columns is left as residual filter (no NULL-aware index path)
- NOT IN, MATCH, LIKE, GLOB remain unhandled (future work)
