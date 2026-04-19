description: Under store mode, a CTE referenced by two scalar subqueries yields correct result for one reference and empty for the other (iterator consumed once, not cached)
dependencies: none
files:
  packages/quereus/src/runtime/cache/
  packages/quereus/src/planner/rules/cache/
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/test/logic/49-reference-graph.sqllogic
----

Reproduced by `49-reference-graph.sqllogic:54` under `QUEREUS_TEST_STORE=true`:

```sql
WITH high_values AS (SELECT * FROM t1 WHERE value >= 20)
SELECT
  (SELECT COUNT(*) FROM high_values) AS count,
  (SELECT SUM(value) FROM high_values) AS sum;
-- memory:  { "count": 2, "sum": 50 }
-- store:   { "count": 0, "sum": 50 }
```

`SUM` returns the correct 50, `COUNT` returns 0. The pattern — one subquery sees the full CTE, the second sees an empty stream — is the signature of an async-iterable that's consumed once without being cached. Memory mode handles this (either through CTE caching or because memory scans are cheaply re-iterable), store does not.

### Hypothesis

Either:
- The CTE cache / materialization rule isn't engaging for store-backed scans, so the second scalar subquery re-evaluates against a store scan that was somehow marked-exhausted, or
- Store's `AsyncIterable<Row>` is single-shot and the plan relied on multi-iteration that memory happens to support

### TODO

- Dump the plan for the failing query in both modes (`--show-plan`) and diff
- Confirm whether `CacheNode` is being inserted around the CTE in store mode
- Decide fix location: planner (force materialization for multi-ref CTEs regardless of module) or store (make scans safely re-iterable)
- Re-run `49-reference-graph.sqllogic` in store mode
