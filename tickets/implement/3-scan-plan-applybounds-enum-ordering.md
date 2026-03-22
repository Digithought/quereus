description: Fix applyBound in scan-plan to use explicit op logic instead of numeric enum comparison
dependencies: none
files:
  packages/quereus/src/vtab/memory/layer/scan-plan.ts
  packages/quereus/src/common/constants.ts
  packages/quereus/test/vtab/scan-plan-bounds.spec.ts
----
## Bug

The `applyBound` closure inside `extractRangeBoundsForColumn` (scan-plan.ts, line 212) uses `op > lowerBound.op` and `op < upperBound.op` to decide which bound is "tighter". This assumes ascending numeric ordering of the `IndexConstraintOp` enum values maps to bound strictness — but it doesn't.

Actual enum values (from constants.ts):
- GT = 4, GE = 32 → `GT > GE` is false, so GE always wins for lower bounds
- LT = 16, LE = 8 → `LT < LE` is false, so LE always wins for upper bounds

The correct behavior: exclusive operators (GT, LT) are stricter than inclusive ones (GE, LE) when values are equal.

## Reproducing Test

`packages/quereus/test/vtab/scan-plan-bounds.spec.ts` — 5 tests, all currently fail:
- GT vs GE lower bound (both orderings)
- LT vs LE upper bound (both orderings)
- Combined: all four ops on same column

Run: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/vtab/scan-plan-bounds.spec.ts"`

## Fix

Replace the numeric comparison in `applyBound` (lines 212-222 of scan-plan.ts) with explicit op logic:

```typescript
const applyBound = (op: IndexConstraintOp, value: SqlValue) => {
	if (isLowerBoundOp(op)) {
		if (!lowerBound || op === ActualIndexConstraintOp.GT) {
			lowerBound = { value, op };
		}
	} else if (isUpperBoundOp(op)) {
		if (!upperBound || op === ActualIndexConstraintOp.LT) {
			upperBound = { value, op };
		}
	}
};
```

This always prefers the exclusive operator (GT for lower, LT for upper). When two constraints share the same op, the first one encountered is kept — which is acceptable since a value comparison would require type-aware comparison logic and the cursor-level `planAppliesToKey` filter provides correctness guarantees regardless.

## Impact

Performance-only — cursor-level filtering catches extra rows. Rare in practice since the planner typically generates at most one constraint per bound direction per column.

## TODO

- [ ] Apply the fix to `applyBound` in scan-plan.ts (lines 212-222)
- [ ] Run the reproducing test suite and verify all 5 tests pass
- [ ] Run the full test suite to ensure no regressions
