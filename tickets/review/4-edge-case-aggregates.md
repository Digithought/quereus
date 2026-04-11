description: Review sqllogic tests for aggregate edge cases
dependencies: none
files:
  packages/quereus/test/logic/25-aggregate-edge-cases.sqllogic
  packages/quereus/src/func/builtins/aggregate.ts
  packages/quereus/src/func/builtins/json.ts
  packages/quereus/src/runtime/emit/hash-aggregate.ts
  packages/quereus/src/runtime/emit/streaming-aggregate.ts
----
Added `25-aggregate-edge-cases.sqllogic` with focused edge-case tests for the aggregate
subsystem, complementing existing coverage in 07-aggregates, 06.6-aggregate-extended,
and 92-hash-aggregate-edge-cases.

**Test cases added:**

- **HAVING eliminating all groups**: GROUP BY producing groups then HAVING filtering every
  group (sum, count, avg, and complex expression variants) — verifies zero rows returned
- **Type coercion in aggregates**: numeric-looking strings fed to sum()/avg() — verifies
  coercion works, non-numeric strings are skipped, count still counts them
- **Aggregate over empty GROUP BY with no rows**: WHERE filtering all rows with GROUP BY
  present returns zero rows (not the scalar empty-input single-row case)
- **NULL-only column fed to every aggregate type**: count(*), count(x), sum, avg, min, max,
  group_concat, and total all tested simultaneously on all-NULL groups
- **Nested aggregates over window functions**: sum/avg/count(distinct) consuming
  row_number() and rank() output from subqueries
- **group_concat with NULL separator**: verifies fallback to default comma
- **group_concat on empty groups within GROUP BY**: group with all-NULL values returns null
- **json_group_array on empty input**: returns null, not empty array
- **json_group_array with NULLs**: includes null values in the array
- **json_group_object with all NULL keys**: all entries skipped, returns null
- **json_group_array/json_group_object with GROUP BY**: grouped aggregation
- **Boolean coercion in aggregates**: 0/1 integer values with sum/avg
- **ORDER BY aggregate alias**: ascending and descending
- **Mixed DISTINCT and non-DISTINCT aggregates**: count(*), count(val), count(distinct),
  sum, sum(distinct), avg, avg(distinct) in same query
- **Single-value groups with var_samp**: returns NULL when n=1

**Not tested (unsupported in parser):**
- FILTER clause: planner node has the field but parser/AST don't support it
- Multi-column DISTINCT: `count(distinct a, b)` not tested (parser support unclear)

All 1693 tests pass. Build succeeds.
