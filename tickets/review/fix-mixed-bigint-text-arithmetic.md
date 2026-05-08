description: Coerce non-bigint operand through `coerceToNumberForArithmetic` in `mixedBigIntArithmetic` so `bigint + text` (and similar mixed types from ANY columns) returns a numeric result instead of null.
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic
  packages/quereus/test/logic/10-distinct_datatypes.sqllogic
----

## What was built

`mixedBigIntArithmetic` in `packages/quereus/src/runtime/emit/binary.ts` previously cast the non-bigint operand with a TypeScript `as number` assertion, which is a compile-time no-op. When the runtime value was a string (e.g., from an `ANY` column), the float fallback executed `bigintAsNumber + 'text'` and got a string concatenation, which `Number.isFinite` then rejected — silently returning `null`.

The non-bigint side is now normalized via `coerceToNumberForArithmetic` (the same affinity rule used by the non-bigint arithmetic paths) before the integer-promotion / float-fallback split. The integer-promotion path now uses `BigInt(coercedValue)` instead of `BigInt(rawValue as number)`, and the float fallback uses the coerced number directly.

Behavior preserved:
- bigint + bigint → bigint arithmetic (unchanged).
- bigint + integer-valued number (incl. integer-valued numeric string like `'3'` or `'2.0'`) → BigInt promotion.
- bigint + fractional number (incl. fractional numeric string like `'0.5'`) → float fallback.
- bigint + non-numeric string / blob / null → coerces to 0 (matches the non-bigint path).

## Testing

- `packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic` — added 5 new vectors:
  - `9007199254740993 + '3'` → integer string promotes to BigInt; result `9007199254740996`.
  - `'3' + 9007199254740993` → reversed operand order.
  - `9007199254740993 + 'abc'` → non-numeric string coerces to 0; result unchanged in BigInt domain.
  - `9007199254740993 + true` → boolean coerces to 1; BigInt-promoted.
  - `9007199254740993 + '0.5'` → fractional string drops to float fallback; expected `9007199254740992` (IEEE 754 banker's rounding at 2^53).
- Existing 10 vectors in the same file still pass (bigint+bigint regression, integer promotion, float coercion, typeof checks).
- `packages/quereus/test/logic/10-distinct_datatypes.sqllogic:90-94` (`coerce_test` row 1: `5 + '3' = 8`) is the original failure; it now passes once the storage layer hands integer values to the bigint path (downstream lamina-quereus-test corpus runner).
- Full quereus test suite: 993 passing — same as baseline. The one pre-existing failure (`Predicate normalizer / double negation`) is unrelated to this fix.
- Lint clean.

## Usage

```sql
-- ANY-column mixed types now arithmetically combine instead of returning null
CREATE TABLE coerce_test (id INTEGER PRIMARY KEY, a ANY, b ANY);
INSERT INTO coerce_test VALUES (1, 5, '3');
SELECT (a + b) FROM coerce_test WHERE id = 1;  -- 8 (was: null)

-- Holds for boolean / blob / non-numeric coercion too:
SELECT 9007199254740993 + 'abc';   -- 9007199254740993 (string → 0)
SELECT 9007199254740993 + true;    -- 9007199254740994 (true → 1)
```

## Downstream

`lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` lists `10-distinct_datatypes.sqllogic` under `lamina-quereus-string-to-blob-affinity-coercion`. With this fix landed, the lamina-side entry can be retired.

## Review focus

- Confirm the coerce-once pattern (`v1n`/`v2n`) doesn't double-evaluate side-effecting input. (It shouldn't — both inputs are already-resolved `SqlValue`s.)
- The integer-vs-float branch currently picks based on whichever side is non-bigint. If both sides happen to be non-bigint after coercion (impossible on the current call sites, since the helper is only invoked when at least one side is `typeof 'bigint'`), the branch test is still safe — `v1n` is guaranteed `bigint` if `v1` was. Worth confirming that no future call site accidentally feeds two non-bigints in.
- Spot-check that `coerceToNumberForArithmetic(null)` (returns 0) matches the non-bigint generic path — it does today, but the helper is now reachable for `bigint + null` only if a caller passes non-null guards differently. Currently all three call sites guard `v1 !== null && v2 !== null` upstream, so this is moot but worth a glance.
