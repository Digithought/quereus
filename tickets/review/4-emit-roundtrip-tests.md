description: Comprehensive emit/ast-stringify round-trip unit tests
files:
  packages/quereus/test/emit-roundtrip.spec.ts (new — main deliverable)
  packages/quereus/src/emit/ast-stringify.ts (reference)
  packages/quereus/src/emit/index.ts (imports)
  packages/quereus/src/parser/index.ts (imports)
----

## Summary

Created `packages/quereus/test/emit-roundtrip.spec.ts` with 115 tests covering systematic parse→stringify→parse→stringify round-trip verification across all statement types, expression types, identifier quoting, string escaping, and edge cases.

## Test Coverage

### Statement round-trips (62 tests)
- **SELECT**: basic columns, WHERE, ORDER BY, LIMIT/OFFSET, GROUP BY/HAVING, DISTINCT, compound (UNION/UNION ALL/INTERSECT/EXCEPT), subquery in FROM, JOIN variants (INNER, LEFT, CROSS), WITH CTE, WITH RECURSIVE
- **INSERT**: VALUES, SELECT, column list, RETURNING, ON CONFLICT DO NOTHING, upsert (ON CONFLICT DO UPDATE)
- **UPDATE**: basic SET, WHERE, RETURNING
- **DELETE**: basic, WHERE, RETURNING
- **VALUES**: standalone VALUES clause
- **CREATE TABLE**: columns with types, PRIMARY KEY, NOT NULL, UNIQUE, DEFAULT, CHECK, FOREIGN KEY (column + table level), IF NOT EXISTS, GENERATED columns
- **CREATE INDEX**: basic, UNIQUE, IF NOT EXISTS, partial (WHERE)
- **CREATE VIEW**: basic, IF NOT EXISTS, column list
- **DROP**: TABLE, INDEX, VIEW, IF EXISTS
- **ALTER TABLE**: RENAME TO, RENAME COLUMN, ADD COLUMN, DROP COLUMN
- **Transaction**: BEGIN, COMMIT, ROLLBACK, SAVEPOINT, RELEASE, ROLLBACK TO
- **PRAGMA**: bare, = value
- **ANALYZE**: bare, with table name

### Expression round-trips (31 tests)
- Literals (integer, float, negative, string, NULL, blob)
- Column references (simple, table.column)
- Unary operators (NOT, -, IS NULL, IS NOT NULL)
- Function calls (simple, multi-arg, count(*), count(distinct))
- CAST, CASE (simple/searched/with ELSE)
- Subquery, EXISTS, IN (values/subquery), BETWEEN/NOT BETWEEN
- COLLATE, window functions (partition by, order by, frame spec)
- Nested/compound expressions

### Identifier quoting (8 tests)
- Normal, reserved keywords, spaces, digit-prefix, embedded quotes, underscore-prefix

### String literal escaping (4 tests)
- Simple, embedded single quote, empty, multiple quotes

### Edge cases (6 tests)
- NULL literal, aliased expressions, star, table.star, schema-qualified FROM, parseAll multiple statements

## Validation
- All 115 tests pass
- Full `yarn test` suite passes (no regressions)
- No emitter bugs discovered — all round-trips clean

## Not tested (already covered elsewhere)
- Operator precedence parenthesization — `emit-precedence.spec.ts` (24 tests)
- AlterTable/Analyze/CreateAssertion AST construction — `emit-missing-types.spec.ts` (11 tests)
