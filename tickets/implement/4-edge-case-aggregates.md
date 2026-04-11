description: Add edge-case sqllogic tests for aggregate subsystem
dependencies: none (complements 4-coverage-runtime-emitters which targets emitter branch coverage)
files:
  packages/quereus/test/logic/07-aggregates.sqllogic
  packages/quereus/test/logic/06.6-aggregate-extended.sqllogic
  packages/quereus/src/runtime/emit/hash-aggregate.ts
  packages/quereus/src/runtime/emit/streaming-aggregate.ts
  packages/quereus/src/func/builtins/aggregate.ts
----
Focused sqllogic tests targeting aggregate edge cases not covered by the existing test files
(07-aggregates, 06.6-aggregate-extended). The existing tests cover basic NULL handling,
zero-row aggregates, single-row groups, and DISTINCT aggregates. This ticket fills the
remaining gaps.

**Gaps to cover:**

- **HAVING that eliminates all groups**: GROUP BY producing groups, then HAVING filtering every
  group — should return zero rows, not an error
- **Multi-column DISTINCT aggregates**: `count(distinct col1, col2)` or equivalent patterns —
  verify deduplication considers the tuple, not individual columns
- **Type coercion in aggregates**: string values that look numeric fed to `sum()` / `avg()` —
  verify coercion behavior is consistent
- **Aggregate over empty GROUP BY with no rows**: `select count(*), sum(x) from empty_table
  group by y` — should return zero rows (not the scalar empty-input case)
- **NULL-only groups in multiple aggregates**: `select group_concat(x), sum(x), avg(x) from t
  where x is null group by y` — all-NULL column fed to every aggregate type simultaneously
- **Nested aggregates over window functions**: `select sum(rn) from (select row_number()
  over (...) as rn from t)` — aggregate consuming window output
- **Aggregate with FILTER clause** (if supported): `count(*) filter (where x > 0)` edge cases
- **group_concat with NULL separator**: verify NULL separator behavior
- **group_concat on empty group**: should return NULL, not empty string
- **json_group_array / json_group_object with NULLs and empty inputs**

Target test file: `test/logic/25-aggregate-edge-cases.sqllogic`

TODO:
- Create `test/logic/25-aggregate-edge-cases.sqllogic`
- Cover each gap bullet above with at least one test case
- Run tests and verify all pass (or document any bugs found as new fix/ tickets)
