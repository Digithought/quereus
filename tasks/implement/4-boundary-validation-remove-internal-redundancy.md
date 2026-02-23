---
description: Remove redundant internal validation to gain runtime speedups
dependencies: boundary-validation-strengthen (boundary trust must be established first)
---

## Goal

With boundaries validated (see sibling task), remove or simplify redundant checks inside internal/runtime code. Trust that data entering through validated boundaries is well-formed.

## Identified Redundancies

### 1. Aggregate arg-function bounds check — `runtime/emit/aggregate.ts:249,357`
**Pattern:** `aggregateArgFunctions[i] || []` followed by `if (j < argFunctions.length)` inside hot loop.
**Fix:** The `|| []` already guarantees a valid array. The inner bounds check `j < argFunctions.length` is redundant when `args.length` matches the established function count from setup (lines 170-174). Remove the inner bounds check or at minimum replace with a debug assertion that gets compiled out.

### 2. Duplicate initialValue cloning — `runtime/emit/aggregate.ts:206,443,468`
**Pattern:** The same 8-line `typeof initialValue` chain (function, array, object) is copy-pasted three times.
**Fix:** Extract to a shared `cloneInitialValue(initialValue: unknown)` helper at module scope. DRY improvement + reduces bundle size slightly. Not a perf win per se but reduces maintenance burden.

### 3. Repeated ctx.params type guard — `runtime/emit/parameter.ts:24,39`
**Pattern:** `typeof ctx.params === 'object' && ctx.params !== null` checked twice inside the parameter emitter.
**Fix:** `RuntimeContext.params` is always set to an object by `_iterateRowsRawInternal()` (statement.ts:289). The type guard is redundant. Remove the checks and access `ctx.params` directly. If desired, add a single `assert` at the top of the emitter that compiles out in production.

### 4. Filter predicate scalar validation — `runtime/emit/filter.ts:11-15`
**Pattern:** `asPredicateScalar()` does typeof checks on filter expression output.
**Analysis:** This validates the output of internal expression evaluation, which should always return `SqlValue`. The function is cheap (single typeof chain) and provides a safety net. **Keep as-is** — the cost is negligible and it catches bugs in custom functions.

## Implementation Notes

- These changes should only be made AFTER the boundary-strengthening task is complete, since they rely on boundary validation guaranteeing well-formed data.
- For item 1 (aggregate bounds), profile before/after to confirm the hot-loop improvement. The aggregate emitter is called per-row, so removing a branch from the inner loop matters.
- For item 3, ensure `RuntimeContext.params` type is narrowed to `Record<number | string, SqlValue>` (non-nullable) so TypeScript enforces the invariant at compile time.

## TODO

- Extract `cloneInitialValue()` helper in aggregate.ts, replace three copies
- Remove redundant `j < argFunctions.length` bounds check in aggregate hot loop
- Remove `typeof ctx.params` guards in parameter.ts; tighten RuntimeContext.params type if needed
- Run test suite to confirm no regressions
- Run build to confirm type safety
