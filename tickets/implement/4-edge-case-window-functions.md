description: Add edge-case sqllogic tests for window function subsystem
dependencies: none
files:
  packages/quereus/test/logic/07.5-window.sqllogic
  packages/quereus/src/runtime/emit/window.ts
  packages/quereus/src/func/builtins/aggregate.ts
----
Focused sqllogic tests targeting window function edge cases. The existing 07.5-window.sqllogic
covers basic frame specs, RANGE vs ROWS, NULLs in partition/order keys, LAG/LEAD, and ranking
functions. This ticket fills gaps in frame boundary corner cases and partition edge behavior.

**Gaps to cover:**

- **Zero-width frame**: `ROWS BETWEEN 0 PRECEDING AND 0 FOLLOWING` — should include only the
  current row for aggregates like `sum()`, `count()`
- **Frame with current row excluded by boundary**: `ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING`
  — a frame that doesn't include the current row
- **Empty partition**: table with a partition key value that has zero matching rows after a
  WHERE filter applied before windowing — verify no phantom partition appears
- **Single-row partition with all window functions**: verify `row_number()=1`, `rank()=1`,
  `lag()=NULL`, `lead()=NULL`, `sum()=value`, `percent_rank()=0`, `cume_dist()=1`
- **Mixed ASC/DESC in window ORDER BY**: `OVER (ORDER BY a ASC, b DESC)` — verify frame
  boundaries respect the composite ordering
- **Large LAG/LEAD offsets beyond partition**: `lag(x, 100)` on a 5-row partition — should
  return the default value (or NULL)
- **RANGE frame with peers**: `RANGE BETWEEN CURRENT ROW AND CURRENT ROW` on data with
  duplicate order key values — should include all peer rows, not just the current row
- **Window function over zero rows**: `select row_number() over () from t where 1=0` — should
  return zero rows, not error
- **Multiple different window definitions in one query**: several OVER clauses with different
  PARTITION BY and ORDER BY — verify each window is independent
- **Window function in subquery used in outer aggregate**: `select sum(rn) from (select
  row_number() over (order by id) as rn from t)` — composition of window + aggregate

Target test file: `test/logic/27-window-edge-cases.sqllogic`

TODO:
- Create `test/logic/27-window-edge-cases.sqllogic`
- Cover each gap bullet above with at least one test case
- Run tests and verify all pass (or document any bugs found as new fix/ tickets)
