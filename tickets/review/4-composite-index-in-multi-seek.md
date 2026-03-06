description: Composite index IN multi-seek for MemoryTable
dependencies: none
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/test/optimizer/secondary-index-access.spec.ts
  - docs/memory-table.md
----

## Summary

Implemented composite index IN multi-seek for MemoryTable. For a composite index `idx(a, b)`,
queries like `WHERE a IN (1, 2) AND b = 5` now generate individual index seeks for each
combination (cross-product) rather than falling through to a single equality seek on only
the first IN value.

## Changes

### Planner (`rule-select-access-path.ts`)
- Added `cartesianProduct` helper function
- Extended the `hasMultiValueIn` block in `selectPhysicalNodeFromPlan` to handle `seekCols.length > 1`
- Generates cross-product of all column values (IN columns × equality columns)
- Encodes `seekWidth` in `idxStr` for plan=5 so the scan-plan builder can reconstruct composite keys
- Handles `valueExpr` nodes for dynamic IN values

### ScanPlan builder (`scan-plan.ts`)
- Modified plan=5 handling in `buildScanPlanFromFilterInfo` to parse `seekWidth` from idxStr
- When `seekWidth > 1`, groups flat args into composite `equalityKeys` arrays

### No cursor changes
The existing multi-seek loop in `scanBaseLayer`/`scanTransactionLayer` already handles composite keys correctly.

### Docs (`memory-table.md`)
- Updated limitation note to reflect that composite index IN is now supported

## Test cases (for review validation)
- `idx(a, b)` with `WHERE a IN ('tech','music') AND b = 2024` → 2 seeks, correct 2 rows
- `idx(a, b)` with `WHERE a = 'tech' AND b IN (2024, 2025)` → 2 seeks, correct 2 rows
- `idx(a, b)` with `WHERE a IN ('tech','music') AND b IN (2024, 2025)` → 4 seeks (cross-product), correct 4 rows
- Explain shows IndexSeek for composite IN
- Single-column IN regression test still passes
- Full test suite: 756 passing, 0 failing
