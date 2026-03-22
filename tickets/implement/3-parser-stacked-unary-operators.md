description: Extract unary() method from factor() to support stacked unary operators (- -1, NOT NOT x, ~-x)
dependencies: none
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/parser.spec.ts
  packages/quereus/test/logic/03-expressions.sqllogic
----

### Root cause

In `factor()`, unary operators (`-`, `+`, `~`, `NOT`) called `this.concatenation()` for the operand instead of recursing. This meant `- -1`, `NOT NOT x`, `~-x`, etc. failed with "Expected expression" at the second operator.

### Fix applied

Extracted a `unary()` method that handles unary prefix operators recursively, then `factor()` delegates to it:

- `factor()` now calls `this.unary()` as the operand parser for `parseBinaryChain`
- `unary()` matches `MINUS | PLUS | TILDE | NOT`, recurses into itself for the operand, and falls through to `concatenation()` for non-unary atoms
- Precedence preserved: `-a * b` still parses as `(-a) * b`

### Tests added

**parser.spec.ts** — 4 new tests:
- `- -1` (stacked minus without parens)
- `NOT NOT 1`
- `~-5` (mixed stacked unary)
- `-a * b` parses as `(-a) * b` (precedence check)

**03-expressions.sqllogic** — 3 new end-to-end queries:
- `SELECT - -1` → 1
- `SELECT NOT NOT 1` → true
- `SELECT ~-1` → 0

### TODO
- Verify build passes
- Verify all existing tests still pass (182 passing, 1 pre-existing failure in emit-missing-types unrelated to this change)
