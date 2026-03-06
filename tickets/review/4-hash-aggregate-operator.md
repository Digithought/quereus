description: Hash aggregate physical operator with cost-based selection vs sort+stream aggregate
dependencies: none
files:
  - packages/quereus/src/planner/nodes/hash-aggregate.ts (new — HashAggregateNode)
  - packages/quereus/src/planner/nodes/stream-aggregate.ts (reference, unchanged)
  - packages/quereus/src/planner/nodes/plan-node-type.ts (PlanNodeType.HashAggregate already existed)
  - packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts (refactored to ruleAggregatePhysical)
  - packages/quereus/src/planner/cost/index.ts (added hash/stream aggregate cost constants and functions)
  - packages/quereus/src/runtime/emit/hash-aggregate.ts (new — emitHashAggregate)
  - packages/quereus/src/runtime/emit/aggregate.ts (reference, unchanged)
  - packages/quereus/src/runtime/register.ts (registered HashAggregate emitter)
  - packages/quereus/src/planner/optimizer.ts (rule ID renamed to aggregate-physical)
  - docs/optimizer.md (updated Aggregation section)
----

## What was built

A `HashAggregateNode` physical operator that builds a hash map keyed by GROUP BY columns, accumulates aggregate state per group, and emits all groups at the end. The optimizer rule (`ruleAggregatePhysical`) selects between hash aggregate and sort+stream aggregate based on cost.

## Key design decisions

- **No GROUP BY** → always StreamAggregate (no hash map needed for scalar aggregate)
- **Already sorted input** → always StreamAggregate (no sort overhead, preserves output ordering)
- **Unsorted input** → cost comparison: `sortCost(n) + streamAggregateCost(n, groups)` vs `hashAggregateCost(n, groups)`. For any non-trivial input, hash wins because sort is O(n log n).
- Hash aggregate uses `serializeKeyNullGrouping` from `key-serializer.ts` for collation-aware, NULL-grouping key hashing.
- Hash aggregate does NOT preserve ordering (computePhysical returns `ordering: undefined`).

## Cost model

```
HASH_AGG_BUILD_PER_ROW: 0.5    (per-row hashing + map insertion)
HASH_AGG_PER_GROUP: 1.0        (per-group finalization)
STREAM_AGG_PER_INPUT_ROW: 0.1  (per-row, no hashing)
STREAM_AGG_PER_GROUP: 1.5      (per-group finalization)
```

## Test cases to verify

- Basic GROUP BY with hash aggregate (unsorted input, verify correct grouping)
- NULL grouping: GROUP BY with NULL values groups them together
- DISTINCT aggregates: `SELECT grp, COUNT(DISTINCT val) FROM t GROUP BY grp`
- HAVING clause works with hash aggregate
- Scalar aggregate (no GROUP BY) still uses stream aggregate
- Already-sorted input uses stream aggregate (verify via EXPLAIN or plan inspection)
- Multiple aggregate functions in same query
- Empty input produces correct results (no groups → no rows for GROUP BY, one row for scalar)
- GROUP BY on multiple columns
- Collation-aware grouping (NOCASE collation on text GROUP BY column)
- Correlated subqueries in HAVING with hash aggregate
- All 803 existing quereus tests pass unchanged
