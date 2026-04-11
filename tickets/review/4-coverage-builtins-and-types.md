description: Tests for under-covered built-in functions, type system, and conversion paths
dependencies: none
files:
  packages/quereus/test/logic/97-json-function-edge-cases.sqllogic
  packages/quereus/test/logic/98-temporal-edge-cases.sqllogic
  packages/quereus/test/logic/99-conversion-edge-cases.sqllogic
  packages/quereus/test/property.spec.ts
  packages/quereus/test/visitor.spec.ts
----

## What was built

Three new `.sqllogic` test files targeting uncovered branches in built-in functions, type system,
and conversion paths. Extended property-based tests with temporal roundtrip and conversion
idempotency. Extended parser visitor tests with broad node type coverage.

### 97-json-function-edge-cases.sqllogic (~150 test assertions)
- `json_valid`: null, numeric, boolean, native object, malformed JSON strings
- `json_schema`: valid/invalid schemas, non-string schema, invalid JSON input, null
- `json_type`: all JSON types via path, non-existent path, non-string path, null input
- `json_extract`: no paths, non-string path, boolean/object/array extraction, deep nesting, multiple paths, root path
- `json_quote`: null, integer, float, boolean, string with special chars, native object
- `json_object`: odd args, non-string key, empty args, multiple pairs
- `json_array`: empty args, mixed types
- `json_array_length`: non-array, empty array, with path, non-string path, missing path, null
- `json_patch`: add/replace/remove ops, invalid inputs, error paths, missing fields
- `json_insert`: no args, non-string path, existing key (no-op), new key, array append/splice
- `json_replace`: existing key, non-existing key, root path, array element, out of bounds
- `json_set`: existing/new key, root path, array in-bounds/append/gap-fill, deep missing path
- `json_remove`: no paths, existing/non-existing key, array element, out of bounds, invalid path
- `json_group_array`/`json_group_object`: aggregation with nulls, empty tables
- JSON path: quoted keys, bracket notation, nested mixed, invalid paths, path through null
- Deep copy verification: mutation doesn't affect original

### 98-temporal-edge-cases.sqllogic (~80 test assertions)
- `date()`: valid ISO, leap year, non-leap Feb 29 error, year boundary, 'now', null, invalid
- `time()`: valid ISO, midnight, milliseconds, 'now', null, invalid
- `datetime()`: valid ISO, milliseconds, 'now', null, invalid
- `timespan()`: ISO 8601 durations (all components), combined, numeric (seconds), human-readable (full words, abbreviations), negative, null, invalid
- Timespan extraction: all 7 component functions with valid/zero/null/invalid/non-string inputs
- Timespan totals: all 4 total functions with valid/null/invalid inputs
- Temporal arithmetic: date + timespan, cross-year boundary
- TIMESPAN storage/retrieval and WHERE comparison

### 99-conversion-edge-cases.sqllogic (~60 test assertions)
- `integer()`: null, identity, float truncation, string, boolean, zero, empty string, non-numeric error
- `real()`: null, identity, from integer/string/boolean, empty string, non-numeric error
- `text()`: null, from integer/float/boolean/string, empty string
- `boolean()`: null, identity, from integer/string (true/false/yes/no/on/off), invalid error
- `json()`: null, from JSON string/array/number/boolean/null-string, invalid error
- `timespan()`: valid, null, invalid error
- Schema introspection: `schema()`, `table_info()`, `foreign_key_info()`, `function_info()` with valid tables, indexes, foreign keys, non-existent tables, non-string arguments
- Cross-type conversion chains: integer->text->integer, real->text->real, boolean->integer->boolean

### Property-based test extensions (property.spec.ts)
- Temporal Roundtrip: DATE values through `date(dateStr)` with 100 random valid dates
- Temporal Roundtrip: TIME values through `time(timeStr)` with 100 random valid times
- Conversion Idempotency: `integer(integer(x)) = integer(x)` for 100 random integers
- Conversion Idempotency: `real(real(x)) = real(x)` for 100 random floats
- Conversion Idempotency: `text(text(x)) = text(x)` for 100 random strings

### Parser visitor extensions (visitor.spec.ts)
- Statement types: INSERT (VALUES, SELECT, CTE), UPDATE (WHERE, CTE), DELETE (WHERE, CTE), VALUES
- Source types: JOIN, function source, subquery source
- Expression types: CAST, COLLATE, function, subquery, unary, column/identifier
- Complex SELECT: GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET, UNION
- DDL types: CREATE TABLE, CREATE INDEX, CREATE VIEW, DROP

## Testing notes

- All 1468 tests pass (0 failures, 2 pending — pre-existing)
- Build passes
- Lint warnings are pre-existing (not from new code)
- The `.sqllogic` test runner splits on `;` within SQL blocks, so schemas with semicolons in string literals must be avoided (comma-separated used instead for json_schema)
- `json_type(null)` returns the string `"null"` (not SQL null) because `coerceToJsonValue(null)` returns JSON null which `getJsonType` maps to the string
- `json_array_length(null)` returns 0 (not null) because null coerces to JSON null which isn't undefined
- `json_set` with `createParents=true` only creates intermediate structures when the existing value is of the wrong type (e.g. scalar where object expected), not when the intermediate key doesn't exist at all
