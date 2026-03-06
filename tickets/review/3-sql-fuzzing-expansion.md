description: Expanded property-based testing with SQL fuzzing and parser robustness
dependencies: fast-check (devDependency)
files:
  - packages/quereus/test/property.spec.ts
----

## Summary

Extended `property.spec.ts` from 4 property-based test suites to 9, adding:

1. **Parser Robustness** (3 tests) — Random strings, SQL-like fragment mixtures, and random identifiers (bracket-quoted, double-quoted, backtick, reserved words) fed to `Parser.parseAll()`. Asserts: either valid AST or `QuereusError` — never unhandled exceptions.

2. **Expression Evaluation Consistency** (2 tests) — Random arithmetic expression trees (depth 3, ops: +, -, *) evaluated in SQL and JS with results compared. Random boolean comparisons (=, !=, <, >, <=, >=) on integer pairs verified against JS semantics.

3. **Comparison Properties** (3 tests) — Validates `compareSqlValues` maintains:
   - Antisymmetry: `compare(a,b) === -compare(b,a)`
   - Reflexivity: `compare(a,a) === 0`
   - Transitivity: if `a<=b` and `b<=c` then `a<=c`
   Uses mixed types: null, integer, float, string, boolean.

4. **Insert/Select Roundtrip** (5 tests) — Tests value preservation through insert+select for INTEGER, REAL, TEXT, BLOB, and ANY column types.

5. **ORDER BY Stability** (1 test) — Inserts rows with duplicate sort keys, runs ORDER BY twice, asserts identical results.

## Testing Notes

- All 20 property-based tests pass (10 new + 10 existing from 4 original suites)
- `numRuns` kept at 100-200 per test for CI-friendly execution (~3s total)
- Full test suite: 263 passing, 1 pre-existing failure (08.1-semi-anti-join.sqllogic — unrelated)
- Negative integer literals wrapped in parens (e.g., `(-1)`) in generated SQL to avoid parser ambiguity with binary minus

## Key Decisions

- Arithmetic expressions exclude division to avoid division-by-zero and integer/float semantic differences
- Float arbitraries use `noNaN: true, noDefaultInfinity: true` to avoid edge cases that would require special handling
- Boolean comparison results handled as either `true`/`false` or `1`/`0` since Quereus may return either form
