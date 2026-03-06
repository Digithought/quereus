description: Expand property-based testing with random SQL generation and parser robustness
dependencies: fast-check (already a devDependency)
files:
  - packages/quereus/test/property.spec.ts (extend)
  - packages/quereus/src/parser/parser.ts (target)
  - packages/quereus/src/util/comparison.ts (target)
  - packages/quereus/src/util/coercion.ts (target)
----

## Overview

The existing `property.spec.ts` has 4 property-based test suites using fast-check: collation comparator, numeric affinity, JSON roundtrip, and mixed-type arithmetic. This ticket expands coverage with SQL expression fuzzing, parser robustness testing, and additional type system property tests.

The goal is to find crashes, hangs, and inconsistencies — not to test specific features. All tests use `fast-check` arbitraries to generate random inputs.

## Design

Extend `packages/quereus/test/property.spec.ts` with new describe blocks. Keep `numRuns` at 100-200 for CI-friendly execution times.

### New Property Test Suites

**Parser Robustness**
- Generate random strings (including SQL-like fragments mixed with garbage) and feed to `parser.parseAll()`. Assert: either returns a valid AST or throws a `QuereusError` — never an unhandled exception, never hangs. Use `fc.string()` and `fc.mixedCase(fc.constant('select from where ...'))`.
- Generate random identifiers (including unicode, reserved words, quoted with brackets/backticks/double-quotes) and use them in `select [ident] from t`. Assert: parser either accepts or rejects gracefully.

**Expression Evaluation Consistency**
- Generate random arithmetic expressions from a grammar: `expr = literal | expr op expr | (expr)` where `op` is `+`, `-`, `*`, `/`, `%` and `literal` is `fc.integer({min:-100, max:100})`. Build the expression as a SQL string, evaluate via `db.eval('select <expr> as r')`, and also evaluate in JS. Assert: results match (accounting for integer vs float semantics and null/division-by-zero).
- Generate random boolean expressions: `expr AND expr`, `expr OR expr`, `NOT expr`, `literal = literal`, `literal > literal`. Evaluate in SQL and JS, assert consistency.

**Comparison Transitivity**
- Generate triples (a, b, c) of mixed SQL values. If `a <= b` and `b <= c` (via `compareSqlValues`), assert `a <= c`. This tests the total ordering guarantee.
- Generate pairs and verify `compare(a,b) === -compare(b,a)` (antisymmetry).

**Insert/Select Roundtrip for All Types**
- Generate random values for each column type (INTEGER, REAL, TEXT, BLOB, BOOLEAN, NULL). Insert into a table with that column type, select back, verify value matches (accounting for type affinity coercion).
- Test with `ANY` column type — values should roundtrip exactly.

**ORDER BY Stability**
- Insert N rows with duplicate sort keys. Run `ORDER BY` twice on the same data. Assert both results are identical (stability of the sort within the same query execution).

### Key Expected Behaviors
- Parser never produces unhandled exceptions on any input — always `QuereusError` or success
- Comparison functions maintain total ordering (transitivity, antisymmetry, reflexivity)
- Expression evaluation in SQL matches JS semantics for the supported type combinations
- Value roundtrips preserve data according to type affinity rules

## TODO

- Add parser robustness property tests (random strings, random identifiers)
- Add expression evaluation consistency tests (arithmetic, boolean)
- Add comparison transitivity and antisymmetry tests
- Add insert/select roundtrip property tests for all column types
- Add ORDER BY stability test
- Verify all existing property tests still pass
- Run full test suite to confirm no regressions
