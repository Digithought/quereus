description: Fix mixed bigint/number arithmetic returning null — coerce operands when types differ
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic
----

## Summary

Mixed bigint/number arithmetic (e.g., `SELECT 9007199254740993 + 1.5`) previously
returned `null` because JavaScript's `TypeError: Cannot mix BigInt and other types`
was silently caught and swallowed.

## Fix

Extracted a `mixedBigIntArithmetic` helper in `binary.ts` that handles coercion:

1. **Both bigint** → bigint arithmetic (unchanged behavior)
2. **Mixed, number is integer** (`Number.isInteger`) → promote number to `BigInt`, use
   bigint arithmetic (preserves precision for large integers)
3. **Mixed, number is fractional** → convert bigint to `Number`, use float arithmetic
   (precision loss expected and correct for float ops)

The helper replaced identical bigint branches in all three run functions:
`runTemporalArithmetic`, `runNumericOnly`, `runGenericArithmetic`.

Also added `normalizeBigInts` in `logic.spec.ts` to bridge BigInt↔Number comparison
since JSON.parse cannot represent BigInt values.

## Testing

Test file: `03.7-bigint-mixed-arithmetic.sqllogic`

Covers:
- `+`, `-`, `*`, `/`, `%` with mixed bigint/number in both operand orders
- Pure bigint+bigint still works
- `typeof` verification for result types
- Integer number promotion to BigInt (e.g., `bigint + 1` stays in bigint domain)
- Float coercion path (e.g., `bigint + 1.5` uses Number arithmetic)

Key behavioral notes:
- `Number.isInteger(2.0)` is true → `2.0` promotes to BigInt, giving exact results
  (e.g., `9007199254740993 % 2.0 = 1`, not `0` from imprecise float)
- IEEE 754 rounding can make float results integer-valued
  (e.g., `typeof(bigint + 1.5)` → "integer" because result rounds to integer)
