description: Composite index prefix-equality + trailing-range seeks for MemoryTable
files:
  - packages/quereus/src/vtab/memory/module.ts (evaluateIndexAccess — prefix+trailing-range detection)
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts (ScanPlan.equalityPrefix, plan=7 handling, extractRangeBoundsForColumn)
  - packages/quereus/src/vtab/memory/layer/base-cursor.ts (planAppliesToKey prefix branch, composite start key, prefix-based early termination)
  - packages/quereus/src/vtab/memory/layer/transaction-cursor.ts (mirror of base-cursor changes)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts (prefix+range detection block in selectPhysicalNodeFromPlan)
  - packages/quereus/test/optimizer/composite-prefix-range.spec.ts (10 tests)
  - docs/memory-table.md (updated limitation note and feature list)
----

## Summary

Implemented composite index prefix-equality + trailing-range seeks. For a composite index `idx(a, b)`, queries like `WHERE a = 1 AND b > 5` now use the index to seek directly to the `a=1` prefix and scan only the `b > 5` range within it, instead of falling through to a full scan or first-column-only range.

## Architecture

**New plan type: `plan=7` (prefix-range)**

The idxStr encoding is `idx=myIndex(0);plan=7;prefixLen=N` where N is the number of equality-prefix columns. Args contain prefix equality values first, then 0–2 range bound values.

**Four-layer change:**

1. **Module** (`evaluateIndexAccess`): After checking full equality and before the first-column range check, detects partial equality prefix + trailing-range on next column. Returns a `rangeScan` access plan with all seek columns.

2. **Planner** (`selectPhysicalNodeFromPlan`): New block between allEquality and range-only that detects prefix-eq + trailing-range pattern from the seek columns, emits an `IndexSeekNode` with `plan=7;prefixLen=N`.

3. **ScanPlan**: New `equalityPrefix?: SqlValue[]` field. `buildScanPlanFromFilterInfo` handles `plan=7` by extracting prefix values and trailing-column range bounds via `extractRangeBoundsForColumn`.

4. **Cursors** (base + transaction): `planAppliesToKey` gets a prefix-range branch that checks prefix equality then trailing column bounds. Start key construction uses `[...prefix, lowerBound]`. Early termination breaks when prefix no longer matches.

## Test Cases (for validation)

- `idx(a,b)` + `WHERE a = 'tech' AND b > 2023` → returns only matching rows
- `idx(a,b)` + `WHERE a = 'tech' AND b >= 2024 AND b <= 2024` → bounded range within prefix
- `idx(a,b)` + `WHERE a = 'music' AND b > 2023 AND b < 2026` → both bounds
- Rows outside prefix not returned
- Explain shows IndexSeek
- `idx(a,b,c)` + `WHERE a = 'web' AND b = 'error' AND c > 100` → 2-col prefix + trailing range
- Composite primary key prefix-range
- Single-column range regression
- Full equality seek regression
- Upper-bound-only prefix-range
