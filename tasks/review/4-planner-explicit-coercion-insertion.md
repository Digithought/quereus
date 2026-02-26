description: Moved implicit runtime coercion into the planner as explicit CastNodes for cross-category comparisons
dependencies: none
files: src/planner/building/expression.ts, src/runtime/emit/binary.ts, src/runtime/emit/between.ts, src/runtime/emit/cast.ts, src/util/coercion.ts, src/planner/analysis/constraint-extractor.ts, docs/types.md, packages/quereus/README.md, test/logic/03.6-type-system.sqllogic
----

## Summary

Shifted cross-category comparison coercion from runtime to plan time. When the planner builds a BinaryOpNode (comparison) or BetweenNode and detects one operand is numeric while the other is textual, it now wraps the textual operand in an explicit CastNode targeting the numeric side's type (e.g., INTEGER or REAL). This lets the runtime unconditionally use the fast comparison path for same-category operands.

## Changes

**Planner (`expression.ts`)**: Added `insertCrossTypeCoercion()` helper that detects numeric-vs-textual operand pairs and wraps the textual side in a synthetic CastNode. Applied to both comparison operators (`=`, `!=`, `<`, `<=`, `>`, `>=`) and BETWEEN expressions.

**Runtime `binary.ts`**: Removed `coerceForComparison` import and call from `buildGenericComparisonRun`. The generic comparison path now only handles temporal checks — no runtime coercion.

**Runtime `between.ts`**: Rewrote to use the same fast-path/generic-path pattern as `binary.ts`. Removed unconditional `coerceForComparison` calls. Added plan-time type checking to select fast path when all operands share the same type category.

**Runtime `cast.ts`**: Made the `run` function synchronous (was unnecessarily `async`). This fixed constant folding producing Literal nodes with Promise values.

**Constraint extractor**: Updated `isColumnReference`, `isLiteralConstant`, `isDynamicValue`, and `getLiteralValue` to see through planner-inserted CastNodes via `unwrapCast()`. This ensures the optimizer's constraint pushdown still works when CastNodes wrap column references or literals.

**`coercion.ts`**: Deprecated `coerceForComparison` (no longer called from comparison/BETWEEN emission). `coerceForAggregate` and `coerceToNumberForArithmetic` are unchanged — they serve different contexts and may benefit from planner-inserted conversions in a future task.

## Testing

- Added comprehensive sqllogic tests in `03.6-type-system.sqllogic`:
  - Integer column vs text literal (`i = '42'`, `i > '10'`, `i < '100'`)
  - Real column vs text literal (`r = '42.0'`)
  - Text column vs integer literal (`t = 42`)
  - Non-numeric text vs integer (`'abc' = 0`)
  - BETWEEN with mixed types in both directions
  - All-literal cross-category comparisons
  - NOT BETWEEN with cross-category
  - NULL propagation in cross-category comparisons
- Full test suite: 731 passing, 0 failures

## Validation

- Build succeeds with no type errors
- All 731 existing tests pass with no regressions
- The constant-folding fix (sync cast emission) also benefits existing CAST expressions
