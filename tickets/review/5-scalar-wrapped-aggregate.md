description: Fix crash when scalar functions wrap aggregates (e.g. coalesce(max(Id), 0))
dependencies: none
files:
  - packages/quereus/src/planner/building/select-projections.ts (main fix — collectInnerAggregates + analyzeSelectColumns decomposition)
  - packages/quereus/src/planner/building/select-aggregates.ts (hasWrappedAggregates param → needsFinalProjection)
  - packages/quereus/src/planner/building/select.ts (threads hasWrappedAggregates through)
  - packages/quereus/test/logic/07-aggregates.sqllogic (reproducing tests — lines 77-94)
----

## What was built

Fixed `SELECT coalesce(max(Id), 0) FROM T` and similar scalar-wrapping-aggregate patterns that crashed with `Expected AggregateFunctionCallNode but got ScalarFunctionCallNode`.

### Root cause
`analyzeSelectColumns` pushed the entire outer `ScalarFunctionCallNode` into the aggregates list when `isAggregateExpression()` detected an aggregate inside a scalar wrapper. The emitters then failed because they expected `AggregateFunctionCallNode` instances.

### Fix
Three-file change:
1. **`select-projections.ts`**: New `collectInnerAggregates()` walks scalar expression trees and extracts only `AggregateFunctionCallNode` instances (with deduplication). `analyzeSelectColumns` now distinguishes direct aggregates from wrapped ones, returning `hasWrappedAggregates`.
2. **`select-aggregates.ts`**: `buildAggregatePhase` accepts `hasWrappedAggregates` and folds it into `needsFinalProjection`, ensuring `buildFinalAggregateProjections` runs to rebuild outer scalar wrappers.
3. **`select.ts`**: Destructures and passes `hasWrappedAggregates` through.

### How it works
For `SELECT coalesce(max(val), 0) FROM t`:
- Only `max(val)` goes into the aggregates list → emitters handle pure `AggregateFunctionCallNode`
- `needsFinalProjection = true` → `buildFinalAggregateProjections` re-builds `coalesce(max(val), 0)` from AST
- `buildFunctionCall` resolves `max(val)` to a column reference to the aggregate result
- Final `ProjectNode` applies `coalesce(column_ref, 0)` on top

## Tests (07-aggregates.sqllogic lines 77-94)

- `coalesce(max(id), 0)` — basic scalar wrapping aggregate
- `coalesce(max(val), 0)` — with nullable column
- `coalesce(min(val), -1)` — min variant
- `grp, coalesce(max(val), 0) ... GROUP BY grp` — grouped variant
- `max(val) + 1` — binary expression wrapping aggregate

## Validation

- All 1130 tests pass, 0 failures
- No new lint warnings/errors
