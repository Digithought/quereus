description: JSON path operators -> and ->> as syntactic sugar over json_extract
files:
  - packages/quereus/src/parser/lexer.ts (added DARROW token, updated - handler)
  - packages/quereus/src/parser/parser.ts (jsonPath() and jsonPathRhs() methods)
  - packages/quereus/test/logic/06.8-json-path-operators.sqllogic (test coverage)
  - docs/sql.md (operator documentation, grammar update)
  - docs/functions.md (cross-reference with json_extract)
----

## What was built

Added `->` and `->>` binary operators for JSON path access, following SQLite 3.38+ conventions.

### Lexer
- Added `TokenType.DARROW` for `->>`
- Updated the `-` handler to lex `->` vs `->>`  (check for second `>` after first)

### Parser
- Added `jsonPath()` method in the expression precedence chain between `collateExpression()` and `primary()` — binds tighter than concatenation, collate, arithmetic, and comparison
- Added `jsonPathRhs()` for right-hand side parsing with path normalization:
  - String `'name'` → `'$.name'` (auto-prepends `$.` if not starting with `$`)
  - Integer `0` → `'$[0]'` (array index shorthand)
  - Full paths like `'$.a.b'` pass through unchanged
- `->` desugars to `json_extract(expr, path)` function call AST node
- `->>` desugars to `cast(json_extract(expr, path) as text)` — always returns TEXT
- Operators are chainable: `data -> 'a' -> 'b' -> 'c'`

### Test coverage (06.8-json-path-operators.sqllogic)
- `->` with full JSON path, nested path, string shorthand, integer shorthand
- `->` extracting nested objects as native JSON
- `->>` returning TEXT for strings, numbers, and arrays
- `->>` with string and integer shorthand
- Chained `->` operators
- NULL propagation
- Non-existent path returns NULL
- Table data with `->` in projection and WHERE
- Aliased results

### Docs
- `docs/sql.md`: JSON Path Operators section with examples, grammar update
- `docs/functions.md`: Cross-reference with json_extract

## Notes
- `->` returns native JSON values (objects/arrays stay native)
- `->>` wraps in `cast(... as text)`, so arrays serialize as `"1,2"` not `"[1,2]"` due to current cast behavior
- WHERE clause with `data -> 'name' = 'bob'` requires explicit cast for string comparison on some vtab types; tested via `cast(data -> 'name' as text) = 'bob'`
- Full JSON type distinction between `->` and `->>` depends on ticket 4-json-native-object-storage
