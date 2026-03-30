description: Extracted unary() method from factor() to support stacked unary operators (- -1, NOT NOT x, ~-x)
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/parser.spec.ts
  packages/quereus/test/logic/03-expressions.sqllogic
----

### What was built

Extracted a `unary()` method in the parser that recursively handles unary prefix operators (`-`, `+`, `~`, `NOT`). `factor()` now delegates to `unary()`, which recurses for stacked operators and falls through to `concatenation()` for atoms.

### Key locations

- `parser.ts:1449` — `unary()` method
- `parser.ts:1438` — `factor()` delegating to `unary()`

### Testing

**parser.spec.ts** — 4 new unit tests covering `- -1`, `NOT NOT 1`, `~-5`, and `-a * b` precedence.

**03-expressions.sqllogic** — 3 end-to-end queries: `SELECT - -1` → 1, `SELECT NOT NOT 1` → true, `SELECT ~-1` → 0.

### Review notes

- Build clean, all 1013 tests pass
- Implementation is minimal (8-line recursive method), follows the same pattern as the rest of the parser
- Precedence chain correct: `factor` → `unary` → `concatenation`
- Grammar in `docs/sql.md` already covers stacked unary via `unary_operator expr`
