description: Recursive CTE emitter throws spurious error when maxIterations=0 (unlimited) and CTE terminates naturally
dependencies: none
files:
  packages/quereus/src/runtime/emit/recursive-cte.ts
  packages/quereus/src/planner/optimizer-tuning.ts
----
## Defect

In `emitRecursiveCTE`, the post-loop safety check is:

```typescript
if (iterationCount >= maxIterations) {
    quereusError(`Recursive CTE '${plan.cteName}' exceeded maximum iteration limit ...`);
}
```

When `maxIterations === 0` (documented as "unlimited" in optimizer-tuning.ts), the CTE terminates naturally when delta is empty. But the safety check `iterationCount >= 0` is always true, so it throws an error even though recursion completed normally.

The default tuning value is 10000, so this only triggers when `maxRecursion` is explicitly set to 0 via `WithClauseOptions`. Since `??` (nullish coalescing) passes through `0`, `plan.maxRecursion = 0` yields `maxIterations = 0`.

## Fix

Change the safety check to:
```typescript
if (maxIterations > 0 && iterationCount >= maxIterations) {
```

## TODO

- Fix the termination guard in `emitRecursiveCTE`
- Add a test with explicit `maxRecursion = 0` if the SQL syntax supports it, or a unit test exercising the emitter directly
