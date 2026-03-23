description: Extracted unary() method from factor() to support stacked unary operators (- -1, NOT NOT x, ~-x)
dependencies: none
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/parser.spec.ts
  packages/quereus/test/logic/03-expressions.sqllogic
----

### Summary

Extracted a `unary()` method in the parser that recursively handles unary prefix operators (`-`, `+`, `~`, `NOT`). Previously, `factor()` called `concatenation()` directly for the operand, so stacked unary operators like `- -1` failed with "Expected expression" at the second operator.

- `factor()` now calls `this.unary()` as the operand parser for `parseBinaryChain`
- `unary()` matches `MINUS | PLUS | TILDE | NOT`, recurses into itself for the operand, and falls through to `concatenation()` for non-unary atoms
- Precedence preserved: `-a * b` still parses as `(-a) * b`

### Key locations

- `parser.ts:1449` — `unary()` method
- `parser.ts:1438` — `factor()` delegating to `unary()`

### Testing

**parser.spec.ts** — 4 new unit tests:
- `- -1` (stacked minus without parens)
- `NOT NOT 1`
- `~-5` (mixed stacked unary)
- `-a * b` parses as `(-a) * b` (precedence check)

**03-expressions.sqllogic** — 3 end-to-end queries:
- `SELECT - -1` → 1
- `SELECT NOT NOT 1` → true
- `SELECT ~-1` → 0

### Validation notes

- Build passes cleanly
- All unary tests pass (5 total)
- Full test suite: 1 pre-existing failure in `03.7-bigint-mixed-arithmetic.sqllogic` (unrelated bigint issue)
