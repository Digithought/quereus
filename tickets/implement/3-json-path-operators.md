description: JSON path operators -> and ->> as syntactic sugar over json_extract
dependencies: 4-json-native-object-storage (JSON type should use PhysicalType.OBJECT first)
files:
  - packages/quereus/src/parser/lexer.ts (ARROW token exists; add DARROW for ->>)
  - packages/quereus/src/parser/parser.ts (expression parsing for -> and ->>)
  - packages/quereus/src/parser/ast.ts (AST node for JSON path operators, or reuse BinaryExpr)
  - packages/quereus/src/planner/building/ (desugar -> to json_extract call)
  - packages/quereus/src/emit/ast-stringify.ts (stringify -> and ->> operators)
  - docs/sql.md (document operators)
  - docs/functions.md (cross-reference operators with json_extract)
----

## Overview

Add `->` and `->>` binary operators for JSON path access, following SQLite 3.38+ and
PostgreSQL conventions. These are syntactic sugar over `json_extract()`.

- `expr -> path` — extract JSON value at path, returns JSON type (native object)
- `expr ->> path` — extract JSON value at path, returns the scalar SQL value (TEXT for strings/objects, INTEGER/REAL for numbers, etc.)

## Architecture

### Lexer

The `->` token (`TokenType.ARROW`) is already lexed. Add `TokenType.DARROW` for `->>`:
in the `-` handler, after matching `->`, check for another `>` to produce `DARROW`.

### Parser

In the expression parser, add `->` and `->>` as binary operators at appropriate precedence
(lower than comparison, higher than OR/AND — similar to other postfix-like accessors).

Two approaches:
1. **Desugar in parser**: Parse `a -> '$.x'` and emit a `FunctionCallExpr` AST node for
   `json_extract(a, '$.x')`. For `->`, wrap in a cast/conversion to JSON. For `->>`, leave as-is.
2. **New AST node**: Add a `JsonPathExpr` AST node, desugar in planner.

Approach 1 (desugar in parser) is simpler and leverages existing json_extract infrastructure.

### Path argument

The right-hand side of `->` / `->>` should accept:
- String literal: `data -> '$.name'` (full JSON path)
- Identifier/string: `data -> 'name'` (shorthand for `$.name`)
- Integer literal: `data -> 0` (shorthand for `$[0]`)

If the path doesn't start with `$`, prepend `$.` (for strings) or `$[` (for integers).

### Return types

- `->` returns `JSON_TYPE` (native object via json_extract, preserving JSON nature)
- `->>` returns the extracted scalar value (TEXT for strings, INTEGER for ints, etc.)
  This maps to `json_extract()` followed by unwrapping from JSON to SQL scalar.

### Test expectations

```sql
select '{"a":1}' -> '$.a';           -- 1 (as JSON)
select '{"a":"hello"}' ->> '$.a';    -- 'hello' (as TEXT)
select '{"a":[1,2]}' -> '$.a';       -- [1,2] (as JSON array)
select '{"a":[1,2]}' ->> '$.a';      -- '[1,2]' (as TEXT)
select data -> 'name' from t;        -- shorthand for data -> '$.name'
select data -> 0 from t;             -- shorthand for data -> '$[0]'
```

## TODO

- Add `DARROW` token type to lexer; update `-` handler to lex `->>`
- Add `->` and `->>` to expression parser as binary operators
- Desugar to `json_extract()` call nodes in parser (or planner)
- For `->>`, add a TEXT coercion wrapper so result is always scalar TEXT
- For `->`, ensure return type is JSON
- Update `ast-stringify.ts` to format these operators
- Add sqllogic tests for both operators with various path forms
- Update `docs/sql.md` with operator documentation
- Ensure build and tests pass
