description: applyBound in scan-plan uses numeric enum comparison that doesn't match IndexConstraintOp ordering
dependencies: none
files:
  packages/quereus/src/vtab/memory/layer/scan-plan.ts
  packages/quereus/src/common/constants.ts
----
## Problem

`extractRangeBoundsForColumn` in scan-plan.ts (line 212) uses `op > lowerBound.op` and `op < upperBound.op` to decide which bound is "tighter" when multiple constraints exist on the same column. This assumes a specific numeric ordering of the enum values.

Actual `IndexConstraintOp` values: GT=4, GE=32, LT=16, LE=8.

For lower bounds: `GT(4) > GE(32)` is false — code incorrectly prefers GE over GT.
For upper bounds: `LT(16) < LE(8)` is false — code incorrectly prefers LE over LT.

## Impact

Not a correctness bug — the cursor-level `planAppliesToKey` filters will catch any extra rows. But the scan may start at a sub-optimal position, reading more entries than necessary before filtering.

In practice this rarely triggers because the planner typically produces at most one constraint per bound direction per column.

## Fix

Replace numeric op comparison with explicit logic:
```typescript
// For lower bounds, GT is stricter than GE
if (!lowerBound || op === ActualIndexConstraintOp.GT) {
    lowerBound = { value, op };
}
// For upper bounds, LT is stricter than LE
if (!upperBound || op === ActualIndexConstraintOp.LT) {
    upperBound = { value, op };
}
```

Also consider comparing values when same-op constraints have different values (keep the tighter value).
