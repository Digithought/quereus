description: Add deterministic plan-shape tests that assert optimizer picks expected physical plans
dependencies: none
files:
  packages/quereus/test/plan/
  packages/quereus/test/plan/golden-plans.spec.ts
  packages/quereus/src/planner/rules/predicate/
  packages/quereus/src/planner/rules/join/
  packages/quereus/src/planner/rules/aggregate/
  packages/quereus/src/planner/rules/subquery/
  packages/quereus/src/planner/rules/cache/
  packages/quereus/src/planner/rules/access/
----
Add deterministic tests under `test/plan/` that assert specific optimizer decisions appear in
the query plan. These guard against regressions where queries return correct results via a
worse plan — a class of bug that result-set tests cannot catch.

These are **not** randomized and run as part of the normal automated suite (via Mocha). Each
test constructs a specific schema and query, then inspects the plan using the existing plan
inspection utilities (see `query_plan()` TVF and `golden-plans.spec.ts` for patterns).

**Decisions to assert:**

- **Predicate pushed below join**: `select * from a join b on a.id = b.a_id where a.x > 10`
  — assert the `x > 10` predicate appears on the `a` side of the join, not above it.

- **Predicate pushed through projection / alias**: `select * from (select a.*, a.x+1 as y from
  a) v where v.x > 10` — assert the `x > 10` predicate reaches the base scan.

- **Index selected over sequential scan**: table with a non-PK index and a WHERE clause that
  matches it — assert the plan uses an index access path, not a full scan.

- **Bloom (hash) join chosen for equi-joins on non-ordered keys**: two tables joined on a
  non-PK column with no available ordering — assert `BloomJoin` appears in the plan.

- **Merge join chosen when both inputs are naturally ordered**: two tables joined on their
  primary keys, both scanned in PK order — assert `MergeJoin` appears in the plan. See
  companion ticket `4-merge-join-coverage` for the stats/ordering setup that enables this.

- **Streaming aggregation when input is pre-sorted**: `select a.x, count(*) from a group by
  a.x` where `x` is the PK — assert `StreamAggregate`, not `HashAggregate`.

- **Correlated IN/EXISTS decorrelated into semi-join**: `select * from a where exists (select
  1 from b where b.x = a.x)` — assert a `SemiJoin` (or decorrelated equivalent) appears
  rather than a correlated subquery.

- **CTE materialized vs inlined based on reference count**: single-reference CTE should inline;
  multi-reference CTE should materialize. Assert the appropriate shape for each case.

- **Constant folding collapses literal arithmetic**: `where 1 + 1 = 2` should be folded to a
  constant (or eliminated entirely), not evaluated per row.

**Approach**: extend `test/plan/golden-plans.spec.ts` or add a new spec file per category
(`test/plan/predicate-pushdown.spec.ts`, `test/plan/join-selection.spec.ts`, etc). Assertions
can use substring/regex matching against the plan text, or structural matching against
`query_plan()` JSON output.

When a rule regresses, the test fails fast with a clear "expected StreamAggregate, got
HashAggregate" message — a much better signal than a sqllogic result diff.

TODO:
- Audit existing `test/plan/` spec files — note what shapes are already asserted
- Decide per-category test files vs one monolithic file (prefer per-category)
- Write predicate pushdown assertions (basic + through alias/projection)
- Write index selection assertions
- Write join algorithm selection assertions (nested-loop / bloom / merge)
- Write aggregate strategy assertions (stream vs hash)
- Write subquery decorrelation assertions
- Write CTE materialization assertions
- Write constant folding assertions
- Verify all tests pass against current optimizer; file fix/ tickets for anything that
  doesn't behave as expected
