description: Systematic audit and expanded test coverage for all error paths and StatusCode values
dependencies: none
files:
  packages/quereus/src/common/errors.ts
  packages/quereus/src/common/types.ts
  packages/quereus/test/logic/90-error_paths.sqllogic
  packages/quereus/test/logic/90.1-parse-errors.sqllogic
  packages/quereus/test/logic/90.2-alter-table-errors.sqllogic
  packages/quereus/test/logic/90.3-expression-errors.sqllogic
  packages/quereus/test/logic/90.4-dml-errors.sqllogic
----
## Summary

Systematic audit of all `QuereusError` throw sites (700+ across 77 files) cross-referenced
against existing test coverage (236+ error directives across 47 test files). Four new test
files created covering previously untested error paths.

## New Test Files

### 90.1-parse-errors.sqllogic (14 tests)
Parser/syntax error edge cases:
- Unterminated parenthesis (`SELECT abs(1` without closing `)`)
- CTE syntax errors: missing name, missing AS, bad column list, missing query paren
- Unterminated string literal
- Incomplete statements: CREATE, INSERT, UPDATE, DELETE
- Empty CREATE TABLE column list
- DROP with unsupported object type (TRIGGER)
- Incomplete CASE expression (missing END)
- Missing WHERE expression

### 90.2-alter-table-errors.sqllogic (6 tests)
ALTER TABLE error paths not covered in `41-alter-table.sqllogic`:
- RENAME COLUMN with non-existent source column
- RENAME COLUMN to existing column name
- DROP COLUMN on non-existent column
- DROP COLUMN on PRIMARY KEY column (explicit and implicit PK)
- RENAME TABLE to existing table name

### 90.3-expression-errors.sqllogic (6 tests)
Expression, subquery, aggregate, and window function errors:
- Scalar subquery returning multiple columns
- IN subquery returning multiple columns
- Duplicate CTE name in WITH clause
- Aggregate function used in WHERE clause (wrong context)
- Window function (rank) without required ORDER BY
- Invalid RETURNING qualifiers (OLD in INSERT, NEW in DELETE)

### 90.4-dml-errors.sqllogic (5 tests)
DML edge case errors:
- VALUES column count mismatch (fewer and more values than columns)
- INSERT with non-existent column in explicit column list
- ON CONFLICT target referencing non-existent column
- Mutating subquery without RETURNING clause

## StatusCode Coverage Summary

**Actively used (12 of 31):**

| StatusCode | Value | Usage | Test Coverage |
|---|---|---|---|
| OK | 0 | Success return | N/A |
| ERROR | 1 | General errors (schema, semantic, DDL) | Extensive |
| INTERNAL | 2 | Internal planning/runtime errors | Via integration tests |
| BUSY | 5 | Database busy state | vtab layer |
| READONLY | 8 | Read-only table modification | Via committed snapshot tests |
| NOTFOUND | 12 | Parameter/assertion not found | Via assertion tests |
| CONSTRAINT | 19 | Constraint violations (NOT NULL, CHECK, UNIQUE, FK) | Extensive |
| MISMATCH | 20 | Type conversion failures | Via conversion/temporal tests |
| MISUSE | 21 | API misuse (closed DB, bad args) | Via integration-boundaries.spec.ts |
| FORMAT | 24 | Access plan format validation | Via vtab tests |
| RANGE | 25 | Parameter index out of bounds | API-level only |
| SYNTAX | 29 | Syntax/parse errors | Via 90.1 and 90 tests |
| UNSUPPORTED | 30 | Unimplemented features | Via RETURNING/JOIN tests |

**Dead/unused (18 of 31) — defined in StatusCode enum but never thrown:**
PERM(3), ABORT(4), LOCKED(6), NOMEM(7), INTERRUPT(9), IOERR(10), CORRUPT(11),
FULL(13), CANTOPEN(14), PROTOCOL(15), EMPTY(16), SCHEMA(17), TOOBIG(18),
NOLFS(22), AUTH(23), NOTADB(26), NOTICE(27), WARNING(28)

These are SQLite-compatible status codes kept for API compatibility but not used
by quereus's virtual-table-based architecture. Consider documenting them as
reserved-for-compatibility or removing if API compatibility is not a goal.

## Findings

1. **"Cannot drop the last column" is unreachable**: In quereus's key-based design,
   every table has an implicit PK. A single-column table's column is always the PK,
   so `Cannot drop PRIMARY KEY column` fires before `Cannot drop the last column`.

2. **Parameter binding errors (RANGE, NOTFOUND) are API-only**: Cannot trigger via
   sqllogic tests since the `-- params:` directive only applies to result checks,
   not error checks. These are covered by `integration-boundaries.spec.ts`.

3. **MISUSE errors are API-only**: Database-close and statement-finalization errors
   require programmatic access. Covered by `integration-boundaries.spec.ts`.

## Validation

- All 1728 tests pass (0 failures, 2 pending)
- TypeScript build clean (`tsc --noEmit` passes)
- No regressions in existing test files
