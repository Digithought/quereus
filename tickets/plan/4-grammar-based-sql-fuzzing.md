description: Grammar-guided SQL fuzzer for deep parser/planner/runtime coverage
dependencies: fast-check (already in devDependencies)
files: test/property.spec.ts, src/parser/parser.ts, src/parser/lexer.ts
----

The existing parser robustness tests feed random strings and SQL-like fragments.  Most random strings are syntactically invalid and exercise only error-recovery paths.  A grammar-guided fuzzer that generates *syntactically valid* SQL will push much deeper into the planner, optimizer, and runtime.

**Grammar-guided generation**
Build a fast-check arbitrary that generates valid SQL ASTs (or SQL fragments), then serializes them to SQL strings.  The grammar should cover:

- SELECT with expressions, aliases, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT
- JOINs (INNER, LEFT, RIGHT, CROSS) with ON conditions
- Subqueries (scalar, EXISTS, IN, table-valued)
- CTEs (WITH ... AS)
- Set operations (UNION, INTERSECT, EXCEPT)
- Window functions with frame specs
- Aggregate functions
- INSERT, UPDATE, DELETE with WHERE and RETURNING
- CREATE TABLE with column types, constraints, PRIMARY KEY

Use `letrec` from fast-check for recursive structures (nested subqueries, expressions).  Keep depth bounded to avoid combinatorial explosion.

**Test modes**

1. *No-crash*: generated SQL should either succeed or throw a QuereusError — never an unhandled exception, hang, or OOM.
2. *Differential* (future): combine with a SQLite oracle to compare results.  This can be a follow-on from this ticket or from the differential testing strategy.

**Practical notes**
- Generate table schemas first, then generate queries that reference those schemas with valid column names.  Invalid-reference queries are fine too (should produce clean errors), but the emphasis should be on exercising execution.
- Bound expression depth (3-4 levels), row count (≤20), and table count (≤3) to keep individual test cases fast.
- Use fast-check's `--seed` for reproducibility.
