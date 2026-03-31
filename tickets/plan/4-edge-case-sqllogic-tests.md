description: Systematic edge-case SQL logic tests covering known bug-cluster areas
dependencies: none
files: test/logic/
----

Many SQL engine bugs cluster around predictable edge cases.  This ticket adds targeted sqllogic test files that systematically sweep through these areas.  Each area should be its own sqllogic file (or a section in an existing file if it fits naturally).

**Empty tables (0 rows)**
- SELECT from empty table with and without WHERE
- Aggregates over empty table: count, sum, avg, min, max, group_concat
- JOINs where one or both sides are empty (INNER, LEFT, RIGHT, CROSS)
- Subqueries returning empty (EXISTS, IN, scalar)
- CTE that produces 0 rows, referenced in outer query
- UNION/INTERSECT/EXCEPT where one or both sides are empty
- INSERT ... SELECT from empty source
- UPDATE/DELETE on empty table (should succeed with 0 affected)
- Window functions over empty result set

**Single-row tables**
- All join types with single-row on one or both sides
- GROUP BY on single row
- Window functions with single-row partition

**NULLs in every position**
- NULL in join keys (both sides, one side)
- NULL in GROUP BY key
- NULL in ORDER BY column
- NULL in CASE WHEN condition and branches
- NULL in IN list and as IN operand
- NULL in aggregate arguments (verify skipping)
- NULL in window function ORDER BY / PARTITION BY
- NULL in COALESCE chains
- NULL compared with every operator (=, <>, <, >, <=, >=, IS, IS NOT)
- NULL in DISTINCT

**Boundary values**
- INTEGER: 0, -1, 1, MAX_SAFE_INTEGER, MIN_SAFE_INTEGER
- REAL: 0.0, -0.0, very small, very large, fractional precision
- TEXT: empty string, single char, string with embedded quotes/newlines/NUL
- BLOB: empty blob, single byte

**Self-joins**
- Table joined to itself with aliases
- Self-join with aggregation
- Correlated subquery referencing outer same-table

**Duplicate values**
- GROUP BY with all duplicate keys
- DISTINCT on all-duplicate column
- ORDER BY on column with ties (verify stability / determinism)
- JOIN with many-to-many matching keys
- IN subquery returning duplicates

**Correlated subqueries**
- Correlated subquery with empty correlation (outer row produces no match)
- Multi-level correlation (subquery of subquery referencing outermost)
- Correlated EXISTS vs IN equivalence
- Correlated subquery in SELECT list, WHERE, and HAVING

**CTEs**
- CTE referenced multiple times in same query
- CTE referencing another CTE
- Recursive CTE (if supported) edge cases: 0 iterations, 1 iteration
- CTE with zero columns selected from it (just EXISTS check)

**Mixed type expressions**
- Arithmetic on mixed integer/real
- Comparisons across types (text vs number where applicable)
- CASE with branches returning different types
- UNION where corresponding columns have different types
