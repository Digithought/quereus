---
description: Emit-time type specialization for binary operators and aggregate coercion
dependencies: None (uses existing plan-time type info via ScalarPlanNode.getType())
---

## Architecture

Use plan-time type information available at emission to select specialized runtime `run` functions, eliminating unnecessary type checks and coercion on the hot path. The approach extends the existing emit-time resolution pattern (already used for collation lookup) to operator dispatch.

### Core Principle

At emit time, `plan.left.getType().logicalType` and `plan.right.getType().logicalType` provide `isNumeric`, `isTextual`, `isTemporal` flags. Use these to select among specialized `run` closures. Fall back to the current generic implementation for unknown/mixed types.

### Phase 1: Arithmetic Specialization (`binary.ts` — `emitNumericOp`)

**Current hot path per evaluation** (even for `integer + integer`):
1. `tryTemporalArithmetic()` → 6+ regex tests against string patterns
2. Null check
3. `typeof v1 === 'bigint'` branch
4. `coerceToNumberForArithmetic()` → 4 typeof checks per operand
5. `Number.isFinite()` result check

**Specialization decision tree at emit time:**

```
if (leftLogical.isTemporal || rightLogical.isTemporal)
  → emit current code (temporal path first) or route to emitTemporalArithmetic
else if (leftLogical.isNumeric && rightLogical.isNumeric)
  → emit numericOnlyArithmetic: skip temporal check entirely
    inner run: null checks → bigint branch → direct inner(v1, v2)
else
  → emit generic path (current code with temporal check, for TEXT+TEXT concat-like scenarios)
```

The numeric-only path eliminates the `tryTemporalArithmetic()` call (the most expensive part: 6 regex tests) and `coerceToNumberForArithmetic()` (values are already numeric).

**Key files:**
- `packages/quereus/src/runtime/emit/binary.ts:47-118` — `emitNumericOp()`
- `packages/quereus/src/runtime/emit/temporal-arithmetic.ts:52-234` — `tryTemporalArithmetic()` to understand what's being skipped
- `packages/quereus/src/util/coercion.ts:30-41` — `coerceToNumberForArithmetic()` to understand what's being skipped
- `packages/quereus/src/planner/nodes/scalar.ts:126-184` — BinaryOpNode.generateType() for type inference rules

**Note**: Even for INTEGER+INTEGER, we must still handle the bigint branch (PhysicalType.INTEGER covers both `number` and `bigint`). But we skip temporal regex and String coercion.

### Phase 2: Comparison Specialization (`binary.ts` — `emitComparisonOp`)

**Current hot path per comparison:**
1. Null check
2. `tryTemporalComparison()` → 2 regex `isTimespanValue()` tests
3. `coerceForComparison()` → 4+ typeof checks to detect numeric-vs-text mismatch
4. `compareSqlValuesFast()` → 2 `getStorageClass()` calls → switch dispatch

**Specialization decision tree at emit time:**

```
needsTemporalCheck = leftLogical.isTemporal || rightLogical.isTemporal
bothSameCategory  = (both isNumeric) || (both isTextual) || (leftLogical === rightLogical)

if (!needsTemporalCheck && bothSameCategory)
  → emit fast comparison: null checks → compareSqlValuesFast() directly (no temporal, no coercion)
  → for both-numeric: can further inline to compareNumbers() avoiding getStorageClass overhead
  → for both-text: can inline to collationFunc(a as string, b as string)
else
  → emit generic path (current code)
```

**Even faster for known same-type comparisons**: When `leftLogical === rightLogical` and it has a `compare()` method, use `logicalType.compare(a, b, collation)` directly. This is already implemented in `comparison.ts:453-481` as `compareTypedValues()` — but never used from binary emit.

**Key files:**
- `packages/quereus/src/runtime/emit/binary.ts:120-253` — `emitComparisonOp()`
- `packages/quereus/src/runtime/emit/temporal-arithmetic.ts:273-302` — `tryTemporalComparison()`
- `packages/quereus/src/util/coercion.ts:48-73` — `coerceForComparison()`
- `packages/quereus/src/util/comparison.ts:210-229` — `compareSqlValuesFast()`
- `packages/quereus/src/util/comparison.ts:453-481` — `compareTypedValues()` (already exists, unused from emit)

### Phase 3: Aggregate Coercion Skip (`aggregate.ts` emit)

**Current per-row overhead:**
- `coerceForAggregate(rawValue, funcName)` called per argument per row → `toUpperCase()`, Set lookup, potential `tryCoerceToNumber()`

**Specialization at emit time** (in `emitStreamAggregate`, lines 220-221 and 328-330):
- If the argument's plan type is already numeric (`argPlanNode.getType().logicalType.isNumeric`), skip `coerceForAggregate()` and use the raw value directly
- Requires passing type info through to the aggregate argument evaluation loop

**Key files:**
- `packages/quereus/src/runtime/emit/aggregate.ts:219-221,328-330` — coercion call sites
- `packages/quereus/src/util/coercion.ts:82-93` — `coerceForAggregate()`

### Phase 4 (stretch): String Function Specialization

Lower priority. When input type is known TEXT and non-nullable:
- `lower(x)` / `upper(x)`: skip `typeof arg === 'string'` check
- `length(x)`: skip null check and instanceof check
- Various functions: skip `String(val)` coercion

This could be done via `customEmitter` on function schemas, but the per-call savings are small (one typeof check). Defer unless profiling shows it matters.

## Testing Strategy

- All existing SQL logic tests must continue to pass (regression)
- Add a performance sentinel (or extend existing one) that benchmarks arithmetic-heavy and comparison-heavy queries to verify speedup
- Specifically test edge cases:
  - NULL operands with specialized paths
  - Mixed-type comparisons (ensure generic fallback works)
  - Temporal arithmetic still works when types are temporal
  - Aggregates with string-that-looks-numeric input still coerce correctly when type is TEXT

## TODO

### Phase 1: Arithmetic
- [ ] In `emitNumericOp()`, read operand types and branch into specialized emitters
- [ ] Implement `emitNumericOnlyOp()` that skips temporal check entirely
- [ ] Ensure temporal types still route through `tryTemporalArithmetic()` correctly
- [ ] Run full test suite

### Phase 2: Comparison
- [ ] In `emitComparisonOp()`, read operand types and branch
- [ ] Implement fast comparison path (no temporal check, no coercion) for same-type operands
- [ ] Consider using `logicalType.compare()` for known same-type
- [ ] Run full test suite

### Phase 3: Aggregate coercion
- [ ] In `emitStreamAggregate()`, pass argument type info to the runtime loop
- [ ] Skip `coerceForAggregate()` when argument type is already numeric
- [ ] Run full test suite

### Phase 4 (stretch): String functions
- [ ] Profile to determine if worth the complexity
- [ ] If so, add custom emitters for high-frequency string functions
