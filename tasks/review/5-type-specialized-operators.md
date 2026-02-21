---
description: Emit-time type specialization for binary operators and aggregate coercion
---

## Summary

Used plan-time type information available at emission to select specialized runtime `run` functions, eliminating unnecessary type checks and coercion on hot paths.

### Changes Made

**Phase 1: Arithmetic Specialization** (`packages/quereus/src/runtime/emit/binary.ts`)
- `emitNumericOp()` now reads `plan.left.getType().logicalType` and `plan.right.getType().logicalType` at emit time
- Three specialized paths:
  - **Temporal path**: when either operand has `isTemporal`, routes through `tryTemporalArithmetic()` first (same as before)
  - **Numeric-fast path**: when both operands are `isNumeric`, skips temporal check and `coerceToNumberForArithmetic()` entirely — values are used directly as `number | bigint`
  - **Generic path**: for TEXT or mixed types, preserves full temporal check + coercion (same as before)

**Phase 2: Comparison Specialization** (`packages/quereus/src/runtime/emit/binary.ts`)
- `emitComparisonOp()` refactored to use shared `buildCmpToResult()` helper (eliminates per-operator code duplication)
- Two specialized paths:
  - **Same-category fast path**: when both operands are same category (both numeric or both textual) and neither is temporal, skips `tryTemporalComparison()` and `coerceForComparison()` — goes directly to `compareSqlValuesFast()`
  - **Generic path**: preserves full temporal check + coercion for mixed-type or temporal operands
- Note: Uses `compareSqlValuesFast()` (not inline casts) to safely handle runtime type mismatches (e.g., parameters declared as TEXT but bound to numeric values)

**Phase 3: Aggregate Coercion Skip** (`packages/quereus/src/runtime/emit/aggregate.ts`)
- Pre-computes `aggregateSkipCoercion[]` boolean array at emit time for each aggregate
- Skips `coerceForAggregate()` when all arguments to a numeric aggregate (SUM, AVG, MIN, MAX, etc.) already have numeric plan-time types
- Applied at both coercion call sites (no-groupby path and GROUP BY path)

**Bonus: Conversion Function Return Types** (`packages/quereus/src/func/builtins/conversion.ts`)
- Fixed all conversion functions (`integer()`, `real()`, `text()`, `boolean()`, `date()`, `time()`, `datetime()`, `timespan()`, `json()`) to declare explicit `returnType` matching their actual output type
- Previously all defaulted to `REAL_TYPE`, causing incorrect plan-time type inference (e.g., `date()` was typed as numeric instead of temporal)

## Testing

- All 639 quereus package tests pass
- The conversion function return type fix was necessary to ensure correct type-based routing (specifically, `date() - date()` temporal arithmetic was broken by the optimization until the return type was corrected)

## Validation Checklist

- [ ] Review arithmetic specialization paths for correctness
- [ ] Review comparison specialization — verify `compareSqlValuesFast` handles all edge cases
- [ ] Review aggregate coercion skip logic
- [ ] Verify conversion function return type changes don't break any downstream type inference
- [ ] Confirm no regressions in temporal arithmetic/comparison tests
- [ ] Consider adding perf sentinel benchmarks for arithmetic-heavy and comparison-heavy queries
