---
description: Access path selection generalized for secondary indexes (seek/range scan)
dependencies: none (self-contained)
---

## Summary

Generalized the Titan optimizer's access path selection to use secondary indexes for seek and range scan operations, not just primary keys.

### Changes

**Interface (`best-access-plan.ts`)**
- Added `indexName` and `seekColumnIndexes` fields to `BestAccessPlanResult`
- Added `setIndexName()` and `setSeekColumns()` to `AccessPlanBuilder`
- Updated `validateAccessPlan` for the new fields

**Memory module (`module.ts`)**
- `evaluateIndexAccess` now returns `indexName` and `seekColumnIndexes` in all code paths
- `findEqualityMatches` handles single-value `IN` as equality
- Removed `value !== undefined` checks to support parameter bindings
- Changed `estimatedRows ?? 1000` to `estimatedRows || 1000` so 0 is treated as "unknown"
- Removed composite prefix+range path (not yet supported at physical scan level)

**Physical node selection (`rule-select-access-path.ts`)**
- Refactored `selectPhysicalNode` into dispatcher + two paths:
  - `selectPhysicalNodeFromPlan`: new index-aware path using `accessPlan.indexName` and `seekColumnIndexes`
  - `selectPhysicalNodeLegacy`: old PK-based heuristic for backward compatibility
- Correct `idxStr` encoding for secondary indexes (e.g., `idx=idx_age(0);plan=2`)

**Grow-retrieve residual fix (`rule-grow-retrieve.ts`)**
- Fixed residual predicate computation: unhandled constraint source expressions (e.g., LIKE that the module can't handle) are now preserved as residual filters above the physical access node

**Runtime DESC index fix (`base-cursor.ts`, `transaction-cursor.ts`)**
- Fixed range scans on DESC secondary indexes: startKey and early termination now account for reversed tree ordering

### Testing

- 7 new tests in `test/optimizer/secondary-index-access.spec.ts`:
  - Equality seek on secondary index
  - Range predicate on secondary index
  - Range scan with both bounds
  - ORDER BY + filter via secondary index
  - Prefers secondary index over full table scan
  - Composite index full equality correctness
  - PK seek still works
- Updated `predicate-pushdown.spec.ts` expectations for IndexSeek behavior
- Updated `80-grow-retrieve-pass.sqllogic` for IndexSeek (no separate FILTER)
- Full test suite: 639 passing, 7 pending, 0 failing

### Key files

| File | Role |
|------|------|
| `src/vtab/best-access-plan.ts` | Interface between planner and vtab modules |
| `src/vtab/memory/module.ts` | Memory module access planning |
| `src/planner/rules/access/rule-select-access-path.ts` | Physical node selection |
| `src/planner/rules/retrieve/rule-grow-retrieve.ts` | Filter absorption with residual |
| `src/vtab/memory/layer/base-cursor.ts` | Base layer scan with DESC fix |
| `src/vtab/memory/layer/transaction-cursor.ts` | Transaction layer scan with DESC fix |
| `test/optimizer/secondary-index-access.spec.ts` | New test file |

### Known limitations

- Composite prefix-equality + trailing-range (e.g., `WHERE city = 'X' AND age > 30` on index `(city, age)`) is not yet supported at the physical scan level. Falls through to range-on-first-column or full scan.
- Sort node growth via `ruleGrowRetrieve` only works when Sort is directly above Retrieve (not when Project sits between them).
