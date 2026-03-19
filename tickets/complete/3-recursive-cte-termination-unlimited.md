description: Fixed recursive CTE emitter spurious error on natural termination
files:
  packages/quereus/src/runtime/emit/recursive-cte.ts
----
## Summary

Fixed the post-loop safety check in `emitRecursiveCTE` that would throw a spurious error in two cases:

1. **maxIterations=0 (unlimited)**: `iterationCount >= 0` was always true, causing an error even on natural termination.
2. **Natural termination at exactly maxIterations**: If the CTE naturally ran out of delta rows on the exact iteration that matched the limit, the check would still trigger.

## Fix Applied

Changed from:
```typescript
if (iterationCount >= maxIterations) {
```

To:
```typescript
if (maxIterations > 0 && iterationCount >= maxIterations && deltaRows.length > 0) {
```

This ensures the error only fires when:
- A finite limit is set (`maxIterations > 0`)
- The limit was reached (`iterationCount >= maxIterations`)
- There was still work to do (`deltaRows.length > 0`)

Applied during review of emit query operations.
