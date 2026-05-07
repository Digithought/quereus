description: Resolve integer literals in GROUP BY and ORDER BY as 1-based positional references into the SELECT list
prereq:
files:
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
  packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic
  packages/quereus/test/logic/90.6-select-error-paths.sqllogic
----

## Summary

This ticket subsumes `tickets/fix/1-fix-order-by-positional-reference.md` (which should be deleted on landing) — ordinal handling in GROUP BY and ORDER BY share semantics and a single resolver should serve both clauses.

`SELECT … GROUP BY 1 [, N…]` and `SELECT … ORDER BY 1 [, N…]` are not handled. Each integer literal is built by `buildExpression` as a constant `LiteralNode` and then:

- In GROUP BY (`select-aggregates.ts:88-89`) it becomes a constant grouping key, which puts every input row in a single group. The subsequent `validateAggregateProjections` then rejects the unrelated SELECT-list column reference with `Cannot mix aggregate and non-aggregate columns…`.
- In ORDER BY (`select-modifiers.ts:50-58, 109-117`) the literal sort key is constant across rows, so the sort is a no-op and the query "succeeds" but is silently unsorted.
- Out-of-range / zero / negative ordinals are silently accepted in both cases.

## Expected behavior

A bare integer literal `N` in GROUP BY or ORDER BY references the `N`th SELECT-list output (1-based). The reference resolves to the same expression that produced that output column — including aliases — so:

```sql
select grp, count(*) as cnt from gx group by 1 order by 1;
-- equivalent to: group by grp order by grp

select grp, sum(val) as total from gx group by 1 order by 2 desc;
-- equivalent to: group by grp order by total desc

select abs(x - 5) as dist from many order by 1;
-- equivalent to: order by abs(x - 5)
```

Out-of-range positions (`order by 0`, `order by -1`, `group by 99` when only N columns are projected) raise an error at planning time.

Only **bare positive integer literals** trigger this — ANY other expression keeps current "expression" semantics (so `group by 1 + 0` is still a constant key, by SQL convention).

## Implementation approach

1. Add a small helper `resolveOrdinalReference(expr, projections, clauseName)` (in `select-aggregates.ts` or a new shared module under `planner/building/`):
   - If `expr.type !== 'literal'` or `typeof expr.value !== 'number'` or `Number.isInteger(value) === false`, return `null` (caller falls through to normal expression building).
   - If `value < 1 || value > projections.length`, throw `QuereusError` (`StatusCode.ERROR`) naming the offending value and the clause (`GROUP BY` / `ORDER BY`).
   - Return the resolved `ScalarPlanNode` from `projections[value - 1].node`.

2. Use the helper in `buildAggregatePhase` when building each `groupByExpression`. The current call (line 88-89):

   ```ts
   stmt.groupBy.map(expr => buildExpression(selectContext, expr, false))
   ```

   becomes:

   ```ts
   stmt.groupBy.map(expr => {
     const resolved = resolveOrdinalReference(expr, projections, 'GROUP BY');
     return resolved ?? buildExpression(selectContext, expr, false);
   })
   ```

   Note: `projections` here is the post-`analyzeSelectColumns` array. Aggregate-only SELECT items (e.g. `count(*) as cnt`) are *not* in `projections` (they're in `aggregates`). The resolver needs the full SELECT-list ordering, so prefer to thread the original `stmt.columns` ordering plus the corresponding scalar nodes (built in `analyzeSelectColumns`) rather than just `projections`. A clean way: have `analyzeSelectColumns` also return a `selectListExprs: ScalarPlanNode[]` array (one entry per `column.type === 'column'` AST item, in source order), and pass that into `resolveOrdinalReference`.

3. Use the same helper in `applyOrderBy` (`select-modifiers.ts:109-117`) and in the pre-projection sort path (`select-modifiers.ts:50-58`). For ORDER BY of an aggregate query the helper resolves against the post-aggregate output projections; for a non-aggregate query it resolves against the pre-projection projections list. Both call sites already have access to the right projection list — wire it through.

4. Re-add the deleted error-assertion cases in `90.6-select-error-paths.sqllogic` for out-of-range ordinals (the previous fix ticket noted these were removed because the engine accepted them silently).

## Tests to enable / add

Uncomment the `-- TODO bug:` blocks marked for ordinals in these files:

- `packages/quereus/test/logic/07.3-group-by-extras.sqllogic` lines 13-15, 17-19, 38-40, 42-44.
- `packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic` lines 17-18, 24-25, 85-86.

Add new positive coverage:

- `group by 1 having count(*) > N` — confirms the resolved expression is the same plan node as the GROUP BY key (HAVING still validates against the same group key).
- `select grp, sum(val) from gx group by 1 order by 2 desc` — ORDER BY ordinal resolves to the aggregate output column.

Add new negative coverage in `90.6-select-error-paths.sqllogic`:

- `select a from t group by 0;` → error
- `select a from t group by 2;` (only 1 column) → error
- `select a from t order by -1;` → error
- `select a from t order by 99;` → error

## Acceptance

- All `yarn build`, `yarn test`, and `yarn lint` (in `packages/quereus`) pass.
- Each newly enabled `-- TODO bug:` ordinal test in `07.3` and `28.2` passes.
- The error-assertion cases in `90.6-select-error-paths.sqllogic` produce the expected error.
- `tickets/fix/1-fix-order-by-positional-reference.md` is deleted (subsumed here).

## TODO

- Decide where to put `resolveOrdinalReference` (new shared file vs. extending `select-aggregates.ts`); thread the SELECT-list expression order through `analyzeSelectColumns`.
- Add the helper + its unit-style coverage via the sqllogic tests above.
- Wire it into GROUP BY building in `select-aggregates.ts`.
- Wire it into the two ORDER BY building sites in `select-modifiers.ts`.
- Uncomment the listed `-- TODO bug:` test blocks (and remove the corresponding non-positional "Equivalent" duplicates if redundant — keep at least one for readability).
- Re-add out-of-range error tests in `90.6-select-error-paths.sqllogic`.
- Delete `tickets/fix/1-fix-order-by-positional-reference.md`.
