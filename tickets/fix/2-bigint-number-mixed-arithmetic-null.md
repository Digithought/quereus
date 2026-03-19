description: Mixed bigint/number arithmetic silently returns null instead of numeric result
dependencies: none
files:
  packages/quereus/src/runtime/emit/binary.ts
----
In `emitNumericOp`, all three run-function variants (runTemporalArithmetic,
runNumericOnly, runGenericArithmetic) enter the bigint branch when
`typeof v1 === 'bigint' || typeof v2 === 'bigint'`, then call
`innerBigInt(v1 as bigint, v2 as bigint)`. When one operand is bigint and the
other is number, JavaScript throws TypeError (cannot mix bigint and number in
arithmetic). The surrounding `try/catch` returns null.

Example: a large INTEGER (stored as bigint) added to a REAL (number) returns
null instead of doing float arithmetic.

The fix should convert the bigint to number when the other operand is number
(precision loss is expected for float arithmetic), or convert the number to
bigint when the other operand is bigint and the number is an integer.

**Severity**: defect (edge case — only triggers for integers exceeding
Number.MAX_SAFE_INTEGER mixed with floats)

## TODO
- In the bigint branch, check if both operands are actually bigint
- If mixed, convert bigint to Number for float arithmetic (or number to bigint
  if the number is integral)
- Add test: `SELECT CAST(9007199254740993 AS INTEGER) + 1.5`
