description: Permit aggregate functions in ORDER BY when the query is itself an aggregate query
prereq:
files:
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
----

## Summary

Aggregate functions in `ORDER BY` are now legal whenever the query is otherwise an aggregate query (has aggregates in `SELECT` / `HAVING`, or has `GROUP BY`). Previously every aggregate in `ORDER BY` was rejected with `Aggregate function <name> not allowed in this context`, even though once the query is aggregating the per-group rows are well-defined.

## Behavior

Now legal:

```sql
-- Aggregate in ORDER BY when the query has GROUP BY
select grp, count(*) as cnt from t group by grp order by count(*) desc;

-- Aggregate referenced only in ORDER BY (not in SELECT)
select grp from t group by grp order by max(val) desc;

-- Aggregate in ORDER BY of a scalar-aggregate query (no GROUP BY)
select count(*) from t order by count(*);

-- Composite ORDER BY mixing aggregates and group-by expressions
select case when val < 20 then 'low' else 'high' end as bucket, count(*) as cnt
from t group by case when val < 20 then 'low' else 'high' end
order by count(*) desc, case when val < 20 then 'low' else 'high' end;
```

Still rejected (no aggregation context to attach the aggregate to):

```sql
select x from t order by sum(x);
-- Aggregate function sum not allowed in this context
```

## Implementation

The HAVING-only-aggregate pattern is now mirrored for ORDER BY:

- `select-aggregates.ts::buildAggregatePhase` walks each `ORDER BY` clause expression with `findAggregateFunctionExprs` and, when the query is already aggregate (`hasAggregates || hasGroupBy`), appends any aggregates not already present in `SELECT`/`HAVING`. The new helpers are `collectOrderByAggregates` and `orderByContainsAggregates`; the de-dupe logic shared with `collectHavingAggregates` is factored into `dedupeNewAggregates`.
- `buildAggregatePhase` now also returns `hasOrderByOnlyAggregates`, `orderByHasAggregates`, and a single shared `aggregatesContext` array (matching `PlanningContext['aggregates']`) so downstream builders can resolve aggregate function calls to `ColumnReferenceNode`s against the `AggregateNode` output.
- `needsFinalProjection` and `preserveForAggregate` are extended with `hasOrderByOnlyAggregates`, so any aggregate added solely for `ORDER BY` is stripped from the output.
- `handlePreAggregateSort` skips the `ORDER BY` → `SortNode → AggregateNode` rewrite when `ORDER BY` itself references aggregates (those evaluate post-aggregation, never per-input row).
- `select-modifiers.ts::applyOrderBy` gained an `allowAggregates` flag threaded from the call site.
- `select.ts` now:
  - Threads `aggregateResult.aggregatesContext` into `selectContext.aggregates` so `applyOrderBy` (and re-built final projections) resolve aggregates to column refs.
  - Promotes the local `hasAggregates` to `true` when `buildAggregatePhase` adds HAVING-only or ORDER-BY-only aggregates, so the post-aggregate branch is taken (this also fixes a pre-existing latent bug where a `HAVING`-only aggregate query could fall into the non-aggregate final-projection branch).
  - When `ORDER BY` references aggregates, applies `applyOrderBy` *before* the final stripping projection — necessary because `ORDER-BY-only` aggregates would otherwise be removed from the row before `Sort` could read them. The post-projection `applyOrderBy` is skipped via an `orderByAppliedEarly` flag. The early apply is gated on `!hasWindowFunctions` so it does not interfere with the window pipeline.

## Use cases for testing / validation

`packages/quereus/test/logic/07.3-group-by-extras.sqllogic` now exercises:

- The previously commented `-- TODO bug:` bucket case (CASE-grouped query with `order by count(*) desc, <case>`).
- `select count(*) as c from aob order by count(*);` — scalar aggregate self-ordering.
- `select grp, sum(val) as s from aob group by grp order by sum(val) desc;` — explicit aggregate expression in ORDER BY (matches the alias-baseline above it).
- `select grp from aob group by grp order by max(val) desc;` — aggregate referenced *only* in `ORDER BY` (forces the ORDER-BY-only-aggregate path: aggregate added to `AggregateNode`, sort applied before strip projection, aggregate stripped from output).
- `select id from aob order by sum(val);` — negative case; expects the `Aggregate function sum not allowed in this context` error.

## Acceptance status

- `yarn build` (tsc) — clean.
- `yarn test` — all 2522 tests pass.
- `yarn lint` (eslint) — clean.
