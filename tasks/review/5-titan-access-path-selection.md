---
description: Generalize access path selection to use secondary indexes for seek/range operations
dependencies: Titan optimizer core (existing), index infrastructure (existing), memory vtab module
---

## Summary

Extended the access path selection pipeline so that secondary indexes (not just the primary key) are used for seek and range operations at both planning and physical node selection time.

## Changes

### `packages/quereus/src/vtab/best-access-plan.ts`
- Added `indexName` and `seekColumnIndexes` fields to `BestAccessPlanResult`
- Added `setIndexName()` and `setSeekColumns()` builder methods on `AccessPlanBuilder`
- Added validation of `seekColumnIndexes` in `validateAccessPlan`

### `packages/quereus/src/vtab/memory/module.ts`
- `evaluateIndexAccess` now sets `indexName` and `seekColumnIndexes` in results for both equality and range plans
- `findEqualityMatches` handles `op === 'IN'` (single-value) as equality
- Both primary and secondary indexes report their identity through the new fields

### `packages/quereus/src/planner/rules/access/rule-select-access-path.ts`
- `selectPhysicalNode` now dispatches to `selectPhysicalNodeFromPlan` when `accessPlan.indexName` and `seekColumnIndexes` are present
- `selectPhysicalNodeFromPlan`: index-agnostic path that builds seek keys from the correct constraint columns (not hardcoded to PK), encodes the correct index name in `idxStr`
- `selectPhysicalNodeLegacy`: preserved PK-based heuristic path for backward compatibility when module doesn't provide the new fields

## Testing

### `packages/quereus/test/optimizer/secondary-index-access.spec.ts` — 7 tests
- Equality seek on secondary index (`WHERE age = 25` → IndexSeek on idx_age)
- Range scan on secondary index (`WHERE age > 30`)
- Range scan with both bounds (`WHERE age >= 25 AND age <= 35`)
- Combined filter + ordering via secondary index
- Cost preference: secondary index over full scan for equality
- Composite index full equality (`WHERE category = 'tech' AND year = 2024`)
- PK seek still works when filtering on primary key

### Validation
- Full test suite: 639 passing, 7 pending, 0 failures
