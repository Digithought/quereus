description: Fix mixed bigint/number arithmetic returning null — coerce operands when types differ
dependencies: none
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic
----

## Problem

In `emitNumericOp` (binary.ts), the three run-function variants
(`runTemporalArithmetic`, `runNumericOnly`, `runGenericArithmetic`) each have
an identical bigint branch:

```js
if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
    try {
        return innerBigInt(v1 as bigint, v2 as bigint);
    } catch {
        return null;
    }
}
```

When one operand is bigint and the other is number, the `as bigint` cast is
only a TypeScript assertion — JavaScript throws `TypeError: Cannot mix BigInt
and other types` at runtime. The `catch` block silently returns `null`.

**Confirmed**: `SELECT 9007199254740993 + 1.5` returns `null`.

## Fix

In each of the three bigint branches (lines ~93-98, ~118-123, ~146-151),
replace the unconditional `innerBigInt` call with mixed-type handling:

1. If both operands are bigint → call `innerBigInt(v1, v2)` (no change)
2. If mixed (one bigint, one number):
   a. If the number operand is integral (`Number.isInteger(n)`) → convert
      number to bigint via `BigInt(n)`, call `innerBigInt`
   b. If the number operand is fractional (float) → convert bigint to Number
      via `Number(bi)`, call `inner` (precision loss expected for float ops)

### Suggested helper (extract to reduce duplication)

Since all three branches have the same logic, extract a shared helper to avoid
repeating the coercion logic three times:

```ts
function mixedBigIntArithmetic(
    v1: SqlValue, v2: SqlValue,
    inner: (v1: number, v2: number) => number,
    innerBigInt: (v1: bigint, v2: bigint) => bigint
): SqlValue {
    if (typeof v1 === 'bigint' && typeof v2 === 'bigint') {
        return innerBigInt(v1, v2);
    }
    // Mixed: one bigint, one number
    const bi = typeof v1 === 'bigint' ? v1 : v2 as bigint;
    const num = typeof v1 === 'bigint' ? v2 as number : v1 as number;
    if (Number.isInteger(num)) {
        try {
            return innerBigInt(bi === v1 ? bi : BigInt(num),
                               bi === v2 ? bi : BigInt(num));
        } catch {
            // Fall through to float path (e.g., BigInt conversion fails)
        }
    }
    // Float path: convert bigint → Number, use float arithmetic
    const n1 = typeof v1 === 'bigint' ? Number(v1) : v1 as number;
    const n2 = typeof v2 === 'bigint' ? Number(v2) : v2 as number;
    const result = inner(n1, n2);
    if (!Number.isFinite(result)) return null;
    return result;
}
```

Then each of the three branches simplifies to:
```js
if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
    try {
        return mixedBigIntArithmetic(v1, v2, inner, innerBigInt);
    } catch {
        return null;
    }
}
```

## Test

A reproducing test is already written:
`packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic`

Covers: `+`, `-`, `*`, `/`, `%` with mixed bigint/number operands in both
orders, pure bigint+bigint, and `typeof` verification. Expected values were
computed from actual JavaScript float arithmetic (precision loss at >2^53 is
expected and correct).

## TODO
- Extract a `mixedBigIntArithmetic` helper in binary.ts
- Replace the bigint branch in `runTemporalArithmetic` (~line 93-98)
- Replace the bigint branch in `runNumericOnly` (~line 118-123)
- Replace the bigint branch in `runGenericArithmetic` (~line 146-151)
- Ensure build passes
- Ensure test `03.7-bigint-mixed-arithmetic.sqllogic` passes
- Ensure existing tests still pass
