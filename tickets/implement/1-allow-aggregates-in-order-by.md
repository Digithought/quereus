description: Permit aggregate functions in ORDER BY when the query is itself an aggregate query
prereq:
files:
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/src/planner/building/function-call.ts
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
----

## Problem

`order by count(*) desc` (or any aggregate expression in ORDER BY) is rejected with `Aggregate function count not allowed in this context` even when the query has a GROUP BY (or is otherwise an aggregate query). This is overly strict — once the query is aggregating, ORDER BY runs over the per-group rows and aggregate references are well-defined.

## Root cause

`applyOrderBy` (`packages/quereus/src/planner/building/select-modifiers.ts:101-118`) and `buildFinalProjections`'s pre-projection sort path (`select-modifiers.ts:49-60`) call:

```ts
buildExpression(orderByContext, orderByClause.expr)
```

without the `allowAggregates: true` flag. `buildFunctionCall` (`packages/quereus/src/planner/building/function-call.ts:67-69`) then throws as soon as it sees an aggregate function schema:

```ts
if (functionSchema && isAggregateFunctionSchema(functionSchema)) {
  if (!allowAggregates) {
    throw new QuereusError(`Aggregate function ${expr.name} not allowed in this context`, …);
  }
```

A second issue: even if the flag were `true`, the aggregate would not be wired into the AggregateNode if it isn't already in the SELECT list. HAVING already solves this with `collectHavingAggregates` (`select-aggregates.ts:431-465`); ORDER BY needs the same treatment.

## Expected behavior

```sql
select case when val < 20 then 'low' when val < 40 then 'mid' else 'high' end as bucket,
       count(*) as cnt
from gc
group by case when val < 20 then 'low' when val < 40 then 'mid' else 'high' end
order by count(*) desc, bucket;
-- legal: count(*) is an aggregate over the GROUP BY groups
```

```sql
select grp from t group by grp order by max(val) desc;
-- legal: max(val) is computed per group, ORDER BY sorts the surviving rows
```

```sql
select count(*) from t order by count(*);
-- legal: scalar aggregate, single row, no-op sort
```

ORDER BY aggregates remain disallowed when the query has no aggregates and no GROUP BY (that's still a type error — there's no "result row" to attach the aggregate to).

## Implementation approach

Extend the HAVING aggregate-collection pattern to ORDER BY:

1. In `buildAggregatePhase` (`select-aggregates.ts:24-127`), after the existing HAVING aggregate collection, also collect ORDER BY aggregates:
   - Add a helper `collectOrderByAggregates(stmt.orderBy, selectContext, aggregates)` mirroring `collectHavingAggregates` (`select-aggregates.ts:431-465`).
   - It walks each `orderByClause.expr` (use `findAggregateFunctionExprs`, same as HAVING) and appends de-duplicated aggregates to the `aggregates` array.
   - Set a flag `hasOrderByOnlyAggregates` analogous to `hasHavingOnlyAggregates`. Folded into `needsFinalProjection` and the `preserveForAggregate` decision in `select.ts:139-152` so the extra aggregates are stripped from the output.

2. In `applyOrderBy` and the pre-projection sort path in `select-modifiers.ts`, pass `allowAggregates: true` to `buildExpression` whenever the query has aggregates or GROUP BY:

   ```ts
   const allowAggInOrderBy = hasAggregates || hasGroupBy; // threaded from the caller
   const expression = buildExpression(orderByContext, orderByClause.expr, allowAggInOrderBy);
   ```

   The existing post-aggregate `selectContext` in `select.ts` already carries the aggregate output scope and `aggregates: aggregatesContext`, so `buildFunctionCall` will resolve the aggregate to a `ColumnReferenceNode` against the AggregateNode output (see `function-call.ts:17-63`). Confirm this path is taken — if not, mirror the `aggregatesContext` setup from `buildFinalAggregateProjections` (`select-aggregates.ts:482-491`).

3. The pre-aggregate sort case (`handlePreAggregateSort` for `hasAggregates && !hasGroupBy && stmt.orderBy`) is exempt — it sorts BEFORE aggregation, so aggregates in ORDER BY don't apply to that path. If an ORDER BY mentions an aggregate AND the query has no GROUP BY, we should NOT pre-aggregate-sort; instead apply ORDER BY post-aggregation. Update `handlePreAggregateSort` (or its caller) to skip pre-aggregate sorting when the ORDER BY contains aggregates — fall through to the standard post-aggregate `applyOrderBy`.

## Tests to enable / add

Uncomment the `-- TODO bug:` block in `packages/quereus/test/logic/07.3-group-by-extras.sqllogic` lines 64-70 and verify the expected output.

Add new positive coverage:

- `select count(*) as c from t order by count(*);` — scalar aggregate path; sort is a single row, just exercises the build.
- `select grp, sum(val) as s from t group by grp order by s desc;` — alias path (already passes); use as the baseline that ordering-by-aggregate-expression matches ordering-by-alias.
- `select grp, sum(val) as s from t group by grp order by sum(val) desc, grp;` — explicit aggregate expression in ORDER BY, equal to the SELECT alias path.
- `select grp from t group by grp order by max(val) desc;` — aggregate referenced in ORDER BY but NOT in SELECT; exercises `hasOrderByOnlyAggregates` (the aggregate is added to the AggregateNode, then stripped from the output via the final projection).

Add new negative coverage:

- `select x from t order by sum(x);` — no GROUP BY, no aggregates in SELECT → should still error (aggregate over an unaggregated relation has no defined evaluation point in this dialect).

## Acceptance

- `yarn build`, `yarn test`, and `yarn lint` (in `packages/quereus`) pass.
- The newly enabled `-- TODO bug:` test in `07.3-group-by-extras.sqllogic` passes.
- New positive tests pass; new negative test errors with a message naming the ORDER BY clause.

## TODO

- Add `collectOrderByAggregates` in `select-aggregates.ts` and call it from `buildAggregatePhase`.
- Set `hasOrderByOnlyAggregates` and fold it into `needsFinalProjection` + `preserveForAggregate` (mirror `hasHavingOnlyAggregates`).
- Update `applyOrderBy` and `buildFinalProjections` pre-projection sort path to pass `allowAggregates: true` when appropriate.
- Adjust `handlePreAggregateSort` to skip pre-aggregate sorting when ORDER BY references aggregates.
- Uncomment the 07.3 test block, add new positive and negative test cases.
