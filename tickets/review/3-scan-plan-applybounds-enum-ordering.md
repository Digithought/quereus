description: Fix applyBound in scan-plan to use explicit op logic instead of numeric enum comparison
dependencies: none
files:
  packages/quereus/src/vtab/memory/layer/scan-plan.ts
  packages/quereus/src/common/constants.ts
  packages/quereus/test/vtab/scan-plan-bounds.spec.ts
----
## What was fixed

The `applyBound` closure in `extractRangeBoundsForColumn` (scan-plan.ts:212) used numeric enum comparison (`op > lowerBound.op` / `op < upperBound.op`) to pick the tighter bound. Because `IndexConstraintOp` enum values don't follow strictness order (GT=4 < GE=32, LT=16 > LE=8), the inclusive operator always won — the opposite of correct behavior.

### Change

Replaced numeric comparison with explicit op checks:
- Lower bound: prefer `GT` (exclusive) over `GE` (inclusive)
- Upper bound: prefer `LT` (exclusive) over `LE` (inclusive)

### Impact

Performance-only — cursor-level `planAppliesToKey` filter guarantees correctness regardless. The fix allows the scan plan to skip rows that would otherwise be scanned and filtered out.

## Testing

5 dedicated tests in `packages/quereus/test/vtab/scan-plan-bounds.spec.ts`:
- GT vs GE lower bound (GT first, GE first)
- LT vs LE upper bound (LT first, LE first)
- Combined: all four ops on same column → GT lower, LT upper

All 5 pass. Full suite: 298 passing, 1 pre-existing failure (bigint-mixed-arithmetic, unrelated).

## Usage

No API or behavioral change. Scan plans now correctly narrow range scans when multiple bound constraints exist on the same column.
