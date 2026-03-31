description: Grammar-guided SQL fuzzer for deep parser/planner/runtime coverage
dependencies: fast-check (already in use)
files: test/property.spec.ts, packages/quereus/src/parser/
----

The existing parser robustness tests feed random strings, which is low-yield because most random strings aren't valid SQL and only exercise error paths. A grammar-guided fuzzer generates *syntactically valid* SQL, hitting the planner, optimizer, and runtime much harder.

### Approach

Build a SQL query generator using fast-check arbitraries that produces valid SQL ASTs (or SQL strings directly) by following Quereus's grammar rules. The generator should be layered:

**Phase 1 — Schema-unaware generation**: Generate syntactically valid SQL without regard to whether tables/columns exist. This stresses the parser and early planner error handling. The expectation is either a valid result or a clean QuereusError — never an unhandled exception, crash, or hang.

**Phase 2 — Schema-aware generation**: Generate a random schema first (tables, columns, types), populate with random data, then generate queries that are valid against that schema. This reaches deep into the optimizer and runtime. Combine with differential testing against SQLite for result validation.

### Generator coverage

The generator should produce queries involving:
- SELECT with expressions, aliases, DISTINCT
- WHERE with boolean logic, comparisons, BETWEEN, IN, LIKE
- JOINs (INNER, LEFT, RIGHT, CROSS) with ON conditions
- GROUP BY with aggregate functions (COUNT, SUM, AVG, MIN, MAX)
- HAVING clauses
- ORDER BY with ASC/DESC, NULLS FIRST/LAST
- LIMIT/OFFSET
- Subqueries (scalar, EXISTS, IN, correlated)
- CTEs (WITH clauses, including recursive)
- Window functions (ROW_NUMBER, RANK, aggregates with OVER)
- Set operations (UNION, INTERSECT, EXCEPT)
- CASE expressions
- CAST / type conversion functions
- NULL literals and IS NULL / IS NOT NULL

### Expectations

For schema-unaware fuzzing: no unhandled exceptions, no hangs, no crashes. Every input either succeeds or throws QuereusError.

For schema-aware fuzzing: results should be deterministic (same query + same data = same result). If combined with differential testing, results should match the oracle (modulo known semantic differences).

### Timeout protection

Wrap each generated query execution in a timeout (e.g., 5 seconds) to catch infinite loops or pathological optimizer behavior.
