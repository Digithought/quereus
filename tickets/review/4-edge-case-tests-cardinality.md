description: Edge-case sqllogic tests for empty tables, single-row tables, and empty set operations
files:
  - packages/quereus/test/logic/20-empty-single-row.sqllogic (new)
----

## Summary

Created `packages/quereus/test/logic/20-empty-single-row.sqllogic` with comprehensive edge-case tests covering table cardinality boundaries.

### Empty table (0 rows) tests:
- SELECT with and without WHERE — all return `[]`
- All aggregate functions (count, sum, avg, min, max, group_concat) — count returns 0, others return null
- Multiple aggregates in one query
- JOINs (INNER, LEFT, CROSS) where one or both sides are empty
- Subqueries returning empty (IN, EXISTS, NOT EXISTS, scalar subquery)
- CTEs producing 0 rows, joined with populated tables
- Set operations (UNION, INTERSECT, EXCEPT, UNION ALL) with empty side
- DML (UPDATE, DELETE) on empty table — succeed with 0 affected rows
- INSERT ... SELECT from empty source — 0 rows inserted
- Window functions (row_number, sum) over empty result set

### Single-row table tests:
- All join types (INNER, LEFT, CROSS) with single-row on one or both sides, matching and non-matching conditions
- CROSS JOIN single-row × multi-row
- GROUP BY on single row with HAVING that matches/doesn't match
- Window functions (row_number, rank, sum, lag, lead) with single-row partition

### Testing notes
- All 1131 quereus tests pass including the new test file
- No pre-existing test failures
- Tests follow the established sqllogic format conventions (lowercase SQL, `→ [json]` results, `:1` suffix for duplicate column names)
