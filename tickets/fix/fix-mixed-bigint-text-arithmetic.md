---
description: `mixedBigIntArithmetic` casts the non-bigint operand with `as number` instead of coercing through `coerceToNumberForArithmetic`. When one side is a bigint and the other is a string (e.g. `5 + '3'` from an ANY column), the float path becomes `5 + '3' = '53'`, fails the `Number.isFinite` check, and returns `null` instead of `8`.
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/src/util/coercion.ts
  packages/quereus/test/logic/10-distinct_datatypes.sqllogic
---

# `mixedBigIntArithmetic` returns null for bigint + text

## Reproduction

```sql
CREATE TABLE coerce_test (id INTEGER PRIMARY KEY, a ANY, b ANY);
INSERT INTO coerce_test VALUES (1, 5, '3');
SELECT (a + b) FROM coerce_test WHERE id = 1;
-- expected: 8
-- actual:   null
```

The row is stored correctly: `a` has `typeof = 'integer'` (stored as `5n` bigint) and `b` has `typeof = 'text'` (stored as `'3'`). The arithmetic operator `+` is what returns null.

`packages/quereus/test/logic/10-distinct_datatypes.sqllogic:90-94` exercises this scenario; it currently fails at line 94. The earlier scenario in the same file (`affinity_test`, lines 70-81) already works because string-to-blob affinity coercion happens at insert time inside the storage layer, not at the SQL operator layer.

## Root cause

`packages/quereus/src/runtime/emit/binary.ts:53-83` (`mixedBigIntArithmetic`) handles the bigint operand cases explicitly but does not coerce the other side when it isn't already a number / bigint. The relevant lines:

```ts
const num = typeof v1 === 'bigint' ? v2 as number : v1 as number;  // string here is unsafe
if (Number.isInteger(num)) {
    // try BigInt promotion path
    ...
}
// Float path
const n1 = typeof v1 === 'bigint' ? Number(v1) : v1 as number;     // string here too
const n2 = typeof v2 === 'bigint' ? Number(v2) : v2 as number;     // string here too
const result = inner(n1, n2);                                      // 5 + '3' = '53'
if (!Number.isFinite(result)) return null;                         // !isFinite('53') ⇒ null
```

When `v2` is a string, the `as number` cast is a no-op (TypeScript-level only), and the JS arithmetic operator concatenates instead of adding. `Number.isFinite('53')` is `false`, so the function returns `null`.

The companion path for non-bigint operands (`runGenericArithmetic`, line 168-190) already uses `coerceToNumberForArithmetic(v1)` / `coerceToNumberForArithmetic(v2)` before invoking `inner`, which correctly maps `'3'` → `3`. Only the bigint-mixed path skips it.

## Suggested fix

In `mixedBigIntArithmetic`, before splitting into BigInt-promotion vs float paths, normalise the non-bigint operand through `coerceToNumberForArithmetic`:

```ts
const v1n = typeof v1 === 'bigint' ? v1 : coerceToNumberForArithmetic(v1);
const v2n = typeof v2 === 'bigint' ? v2 : coerceToNumberForArithmetic(v2);
```

then proceed as today. This preserves bigint precision when both sides are bigint, promotes integer-valued numbers into BigInt, and demotes both to Number when either side is fractional — but additionally maps strings/booleans/blobs through the same affinity rule the rest of the arithmetic path uses.

## Acceptance

- `10-distinct_datatypes.sqllogic` clears line 94 (and the `coerce_test` block more broadly) under the lamina-quereus-test corpus runner.
- The existing test cases in `mixedBigIntArithmetic`'s coverage continue to pass: bigint+bigint stays in BigInt domain, bigint+integer-number promotes, bigint+fractional-number demotes.
- A new vector pins `bigint + text` (and `text + bigint`) → numeric result for ANY-column-shaped values.

## Downstream

`lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` currently lists `10-distinct_datatypes.sqllogic` under `lamina-quereus-string-to-blob-affinity-coercion` (the storage-side bug that has since been fixed). When this upstream fix lands, the lamina-side entry can be retired; until then it points to this ticket.
