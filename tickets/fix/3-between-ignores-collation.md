description: BETWEEN operator ignores operand collation, always uses BINARY
dependencies: none
files:
  packages/quereus/src/runtime/emit/between.ts
  packages/quereus/src/runtime/emit/binary.ts (reference — emitComparisonOp correctly resolves collation)
----
`emitBetween` hardcodes `ctx.resolveCollation('BINARY')` on line 10. This means
`SELECT * FROM t WHERE name COLLATE NOCASE BETWEEN 'a' AND 'z'` uses binary
comparison instead of case-insensitive comparison.

`emitComparisonOp` in binary.ts correctly checks `rightType.collationName` and
`leftType.collationName` before resolving a collation function (lines 186-193).
BETWEEN should follow the same pattern.

**Severity**: defect

## TODO
- Check operand types for collationName (value, lower, upper) and use the
  first non-default collation found, similar to emitComparisonOp
- Add a sqllogic test: `BETWEEN` with `COLLATE NOCASE`
