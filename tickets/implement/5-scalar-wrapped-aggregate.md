description: Fix crash when scalar functions wrap aggregates (e.g. coalesce(max(Id), 0))
dependencies: none
files:
  - packages/quereus/src/planner/building/select-projections.ts (main fix — analyzeSelectColumns + new collectInnerAggregates)
  - packages/quereus/src/planner/building/select-aggregates.ts (accept hasWrappedAggregates flag)
  - packages/quereus/src/planner/building/select.ts (thread hasWrappedAggregates through)
  - packages/quereus/test/logic/07-aggregates.sqllogic (reproducing tests — already added)
----

## Summary

`SELECT coalesce(max(Id), 0) FROM T` crashes with:
```
Expected AggregateFunctionCallNode but got ScalarFunctionCallNode
```

Any scalar expression wrapping an aggregate triggers the same crash: `coalesce(max(...), 0)`, `max(val) + 1`, `ifnull(sum(...), 0)`, `cast(count(*) as text)`, etc.

## Root Cause

In `select-projections.ts:analyzeSelectColumns` (line 132-137), when `isAggregateExpression()` detects an aggregate anywhere inside a scalar wrapper, the **entire outer** `ScalarFunctionCallNode` is pushed into the `aggregates` list. The emitters (`aggregate.ts:176-179`, `hash-aggregate.ts:114-120`) then do `funcNode instanceof AggregateFunctionCallNode` and throw when it's a `ScalarFunctionCallNode`.

## Fix Strategy

The infrastructure for post-aggregate projections already exists via `buildFinalAggregateProjections` (select-aggregates.ts:401-448). When called, it re-builds each SELECT column from the AST in the aggregate output scope. `buildFunctionCall` (function-call.ts:17-63) checks `ctx.aggregates` and resolves matching aggregate calls to `ColumnReferenceNode` references. So `coalesce(max(Id), 0)` naturally becomes `coalesce(<ref_to_max_result>, 0)`.

The fix is to **decompose** compound expressions: extract only the inner `AggregateFunctionCallNode`(s) into the aggregates list, and let `buildFinalAggregateProjections` rebuild the outer scalar wrapper as a post-aggregate projection.

### Detailed Changes

**1. `select-projections.ts` — `analyzeSelectColumns`**

Add a new helper `collectInnerAggregates(node, aggregates)` that walks a `ScalarPlanNode` tree and collects all `AggregateFunctionCallNode` instances (deduplicating against existing entries by comparing `expressionToString(funcNode.expression).toLowerCase()`).

Change the `isAggregateExpression` branch (lines 132-137):
```typescript
} else if (isAggregateExpression(scalarNode)) {
    hasAggregates = true;
    if (CapabilityDetectors.isAggregateFunction(scalarNode)) {
        // Direct aggregate — add as-is (existing behavior)
        aggregates.push({
            expression: scalarNode,
            alias: column.alias || expressionToString(column.expr)
        });
    } else {
        // Scalar wrapping aggregate(s) — extract only the inner aggregate(s)
        collectInnerAggregates(scalarNode, aggregates);
        hasWrappedAggregates = true;
    }
}
```

Return `hasWrappedAggregates` in the result object.

The `collectInnerAggregates` function:
- Walks `node.getChildren()` recursively (same pattern as `isAggregateExpression`)
- When it finds `CapabilityDetectors.isAggregateFunction(child)`, casts to `AggregateFunctionCallNode`, creates alias via `expressionToString(funcNode.expression)`, deduplicates against existing entries, and pushes
- Does NOT recurse into aggregate arguments (aggregates can't nest)

**2. `select-aggregates.ts` — `buildAggregatePhase`**

Add `hasWrappedAggregates: boolean = false` parameter. Fold it into `needsFinalProjection`:
```typescript
const needsFinalProjection = hasHavingOnlyAggregates || hasWrappedAggregates || checkNeedsFinalProjection(projections);
```

This ensures `buildFinalAggregateProjections` is called to rebuild the outer scalar wrappers.

**3. `select.ts` — `buildSelectStmt`**

Destructure `hasWrappedAggregates` from `analyzeSelectColumns` result. Pass it to `buildAggregatePhase`:
```typescript
const aggregateResult = buildAggregatePhase(input, stmt, selectContext, aggregates, hasAggregates, projections, hasWrappedAggregates);
```

### Why This Works

For `SELECT coalesce(max(val), 0) FROM t`:
1. `analyzeSelectColumns` extracts `max(val)` as the only aggregate; `hasWrappedAggregates = true`
2. `AggregateNode` stores only `AggregateFunctionCallNode` instances — emitters are happy
3. `needsFinalProjection = true` → `buildFinalAggregateProjections` is called
4. It re-builds `coalesce(max(val), 0)` from AST; `buildFunctionCall` resolves `max(val)` to a column reference to the aggregate result
5. Final `ProjectNode` applies `coalesce(column_ref, 0)` on top of the aggregate output

For GROUP BY variant `SELECT grp, coalesce(max(val), 0) FROM t GROUP BY grp`:
- Same decomposition; `grp` goes to projections, `max(val)` to aggregates
- `buildFinalAggregateProjections` rebuilds both columns in aggregate output scope
- GROUP BY columns resolve via `createAggregateOutputScope` registration

### Edge Cases

- **Multiple aggregates in one wrapper**: `coalesce(max(val), min(val), 0)` — both `max(val)` and `min(val)` extracted
- **Same aggregate in direct + wrapped form**: `SELECT max(val), coalesce(max(val), 0)` — dedup prevents double-computing; `buildFunctionCall` resolves both to the same column reference
- **Binary expressions**: `max(val) + 1` — `isAggregateExpression` detects it, inner `max(val)` extracted, `+1` applied post-aggregate
- **Cast wrapping**: `cast(count(*) as text)` — same pattern, cast applied post-aggregate
- **Nested scalar wrappers**: `abs(coalesce(sum(val), 0))` — `collectInnerAggregates` recurses through both scalar layers

## Tests

Already in `07-aggregates.sqllogic` (lines 78-93):
- `coalesce(max(id), 0)` — basic case
- `coalesce(max(val), 0)` — with nullable column
- `coalesce(min(val), -1)` — min variant
- `grp, coalesce(max(val), 0) ... GROUP BY grp` — grouped variant
- `max(val) + 1` — binary expression wrapping aggregate

## TODO

- [ ] Add `collectInnerAggregates` helper to `select-projections.ts`
- [ ] Modify `analyzeSelectColumns` to decompose wrapped aggregates and return `hasWrappedAggregates`
- [ ] Add `hasWrappedAggregates` parameter to `buildAggregatePhase` and fold into `needsFinalProjection`
- [ ] Thread `hasWrappedAggregates` through `select.ts`
- [ ] Run tests: `yarn test --grep "07-aggregates"` to confirm fix
- [ ] Run full test suite: `yarn test` to verify no regressions
