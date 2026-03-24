description: BETWEEN operator now respects operand collation instead of hardcoding BINARY
files:
  packages/quereus/src/runtime/emit/between.ts
  packages/quereus/test/logic/03-expressions.sqllogic
----

## What was built

`emitBetween` in `between.ts` was updated to inspect `collationName` on all three operand
types (expr, lower, upper) and use the first non-default collation found, falling back to
BINARY. This follows SQLite's left-operand-takes-precedence rule for BETWEEN (since the
expr is always the left side in the decomposed comparisons `expr >= lower AND expr <= upper`).

Previously, collation was unconditionally hardcoded to BINARY.

## Review notes

- Collation precedence: expr > lower > upper. This correctly follows SQL semantics where the
  left operand's collation takes precedence in comparisons.
- Collation is pre-resolved at emit time (not runtime) for performance.
- Note field now includes collation name when non-BINARY, consistent with `emitComparisonOp`.
- Null handling preserved: any null operand returns null.

## Testing

All 1013 tests pass. Test cases in `03-expressions.sqllogic`:

- COLLATE NOCASE on expr: `'Hello' COLLATE NOCASE BETWEEN 'a' AND 'z'` → true
- Case-sensitive default: `'Hello' BETWEEN 'a' AND 'z'` → false
- NOT BETWEEN with COLLATE: `'Hello' COLLATE NOCASE NOT BETWEEN 'a' AND 'z'` → false
- COLLATE on lower bound: `'hello' BETWEEN 'A' COLLATE NOCASE AND 'Z'` → true
- NULL with COLLATE: `null COLLATE NOCASE BETWEEN 'a' AND 'z'` → null
- NULL bound with COLLATE: `'b' COLLATE NOCASE BETWEEN null AND 'z'` → null
