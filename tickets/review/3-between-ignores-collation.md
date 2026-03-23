description: BETWEEN operator now respects operand collation instead of hardcoding BINARY
dependencies: none
files:
  packages/quereus/src/runtime/emit/between.ts
  packages/quereus/test/logic/03-expressions.sqllogic
----

## Summary

Fixed `emitBetween` in `between.ts` to inspect `collationName` on all three operand types
(expr, lower, upper) and use the first non-default collation found, falling back to BINARY.
This mirrors the pattern used in `emitComparisonOp` (binary.ts).

Previously, the function unconditionally used `ctx.resolveCollation('BINARY')`, causing
queries like `SELECT 'Hello' COLLATE NOCASE BETWEEN 'a' AND 'z'` to return `false` instead
of `true`.

## Key Test Cases

```sql
-- COLLATE NOCASE should make BETWEEN case-insensitive
SELECT 'Hello' COLLATE NOCASE BETWEEN 'a' AND 'z' AS yes1, 'Hello' BETWEEN 'a' AND 'z' AS no1;
→ [{"yes1":true,"no1":false}]

SELECT 'B' COLLATE NOCASE BETWEEN 'a' AND 'c' AS yes2, 'B' BETWEEN 'a' AND 'c' AS no2;
→ [{"yes2":true,"no2":false}]
```

## Validation

- Typecheck: clean
- All sqllogic tests pass including the new BETWEEN+COLLATE cases
- Pre-existing failures (alterTable emit, scan-plan-bounds) are unrelated
