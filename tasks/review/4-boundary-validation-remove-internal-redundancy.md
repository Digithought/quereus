---
description: Review removal of redundant internal validation for runtime speedups
dependencies: boundary-validation-strengthen (completed)
---

## Summary

Removed redundant internal checks that were duplicating work already guaranteed by boundary validation. The changes target three areas in the runtime emitters.

## Changes Made

### 1. Extracted `cloneInitialValue()` helper — `runtime/emit/aggregate.ts`
Three identical 8-line `typeof initialValue` clone blocks were replaced with a single `cloneInitialValue(initialValue: unknown): AggValue` helper at module scope. Pure DRY improvement.

### 2. Removed redundant bounds check in aggregate hot loop — `runtime/emit/aggregate.ts`
The `|| []` fallback on `aggregateArgFunctions[i]` and the inner `j < argFunctions.length` guard were removed. The `aggregateArgFunctions` array is constructed at setup by slicing from the function list (lines 160-174), so `args.length` always matches the slice length. This removes a branch from the per-row inner loop.

### 3. Simplified parameter emitter — `runtime/emit/parameter.ts`
- Removed dead `Array.isArray(ctx.params)` branches and `typeof ctx.params === 'object' && ctx.params !== null` guards
- `ctx.params` is always `Record<number | string, SqlValue>` at runtime (set from `Statement.boundArgs`)
- Tightened `RuntimeContext.params` type from `SqlParameters` (union with array) to `Record<number | string, SqlValue>`
- Added normalization in `database._executeSingleStatement` to convert array params to record at the boundary

### 4. Kept filter predicate validation — `runtime/emit/filter.ts`
Per the task analysis, `asPredicateScalar()` was kept as-is since its cost is negligible and it catches bugs in custom functions.

## Testing & Validation

- Build passes cleanly (TypeScript type-checks with tightened `RuntimeContext.params` type)
- All 279 tests pass (1 pre-existing failure in `41-foreign-keys.sqllogic` unrelated to these changes)
- No behavioral changes — only removed dead branches and deduplicated code

## Files Changed

- `packages/quereus/src/runtime/emit/aggregate.ts` — extracted helper, removed bounds check
- `packages/quereus/src/runtime/emit/parameter.ts` — simplified to use record access directly
- `packages/quereus/src/runtime/types.ts` — tightened `params` type
- `packages/quereus/src/core/database.ts` — normalize array params at boundary
