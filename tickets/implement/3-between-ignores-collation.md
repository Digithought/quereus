description: Fix BETWEEN operator to respect operand collation instead of hardcoding BINARY
dependencies: none
files:
  packages/quereus/src/runtime/emit/between.ts
  packages/quereus/test/logic/03-expressions.sqllogic
----

## Problem

`emitBetween` in `between.ts` hardcoded `ctx.resolveCollation('BINARY')`, ignoring any
`COLLATE` clause on the operands. This meant queries like
`SELECT 'Hello' COLLATE NOCASE BETWEEN 'a' AND 'z'` used binary comparison and
returned `false` instead of `true`.

## Root Cause

Line 10 of `between.ts` unconditionally resolved the BINARY collation:
```ts
const collationFunc = ctx.resolveCollation('BINARY');
```

The analogous code in `emitComparisonOp` (binary.ts lines 181-193) correctly inspects
`leftType.collationName` / `rightType.collationName` before falling back to BINARY.

## Fix

Check `collationName` on all three operand types (`expr`, `lower`, `upper`) and use the
first non-default collation found, falling back to BINARY. This mirrors the pattern in
`emitComparisonOp`.

## Reproducing Test

Added to `03-expressions.sqllogic`:
```sql
SELECT 'Hello' COLLATE NOCASE BETWEEN 'a' AND 'z' AS yes1, 'Hello' BETWEEN 'a' AND 'z' AS no1;
→ [{"yes1":true,"no1":false}]

SELECT 'B' COLLATE NOCASE BETWEEN 'a' AND 'c' AS yes2, 'B' BETWEEN 'a' AND 'c' AS no2;
→ [{"yes2":true,"no2":false}]
```

## TODO
- [x] Check operand types for collationName (value, lower, upper) and use first non-default collation
- [x] Add sqllogic test: BETWEEN with COLLATE NOCASE
- [x] Verify all tests pass (927 passing)
