description: Edge-case sqllogic tests for self-joins, duplicates, correlated subqueries, and CTE edge cases
dependencies: none
files:
  - packages/quereus/test/logic/23-self-joins-duplicates.sqllogic
  - packages/quereus/test/logic/07.8-correlated-subquery-edges.sqllogic
  - packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic
----

Three new sqllogic test files covering query-structure edge cases. All tests pass.

## What was built

### 23-self-joins-duplicates.sqllogic
- Self-joins: basic with aliases, LEFT join for null manager, aggregation (count direct reports), correlated subquery on same table, multi-level (grandparent) join
- Duplicates: GROUP BY with all-duplicate keys, GROUP BY on single-value column, DISTINCT on all-duplicate column, ORDER BY with ties, many-to-many join cartesian products, IN subquery returning duplicates, multi-column DISTINCT

### 07.8-correlated-subquery-edges.sqllogic
- Empty correlation (outer row with no inner match → NULL aggregation)
- Multi-level correlation (subquery-of-subquery referencing outermost table)
- EXISTS vs IN equivalence verification
- Correlated subqueries in SELECT list, WHERE, HAVING positions
- COALESCE over NULL-returning correlated subquery
- NOT IN with NULLs in subquery (classic SQL gotcha — returns empty)

### 13.3-cte-edge-cases.sqllogic
- CTE referenced multiple times in same query (cross join with self)
- CTE referencing another CTE, chain of 3 CTEs
- Recursive CTE with 0 iterations (empty base case)
- Recursive CTE with 1 iteration (base only, no recursion)
- CTE with EXISTS checks (true and false cases)
- CTE in UPDATE/DELETE (documented as not yet supported — expect errors)
- CTE with set operations (UNION, INTERSECT)

## Testing notes
- All 3 files pass (`yarn test` — 0 failures)
- CTE-in-UPDATE and CTE-in-DELETE are not yet supported; tests expect errors and verify no side effects
- The `-- run` directive is used to separate setup statements from error-expected statements in the CTE file

## Key validation scenarios
- NULL handling in self-joins, correlated subqueries, and NOT IN
- Cartesian products from many-to-many joins
- Correct row counts with duplicate values
- Aggregation returning NULL vs 0 for empty correlation sets
- Recursive CTE boundary conditions (0 and 1 iterations)
