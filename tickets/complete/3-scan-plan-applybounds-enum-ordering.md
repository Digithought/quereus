description: Fixed applyBound in scan-plan to use explicit op logic instead of numeric enum comparison
files:
  packages/quereus/src/vtab/memory/layer/scan-plan.ts
  packages/quereus/src/common/constants.ts
  packages/quereus/test/vtab/scan-plan-bounds.spec.ts
----
## What was built

Replaced numeric `IndexConstraintOp` enum comparison in `applyBound` (scan-plan.ts) with explicit op checks. The enum values don't follow strictness order (GT=4 < GE=32, LT=16 > LE=8), so numeric comparison always picked the inclusive operator — the opposite of correct.

### Key changes
- `applyBound` now uses `op === ActualIndexConstraintOp.GT` / `.LT` to prefer exclusive bounds
- Added `isLowerBoundOp` and `isUpperBoundOp` type-guard helpers

### Impact
Performance-only — cursor-level `planAppliesToKey` filter guarantees correctness regardless. Scan plans now correctly narrow range scans.

## Testing
5 tests in `packages/quereus/test/vtab/scan-plan-bounds.spec.ts`:
- GT vs GE lower bound (both orderings)
- LT vs LE upper bound (both orderings)
- Combined: all four ops on same column → GT lower, LT upper

Full suite: 1013 passing, 2 pending (pre-existing).

## Usage
No API change. Internal scan plan optimization.
