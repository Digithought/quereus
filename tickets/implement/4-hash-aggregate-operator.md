description: Hash aggregate physical operator with cost-based selection vs sort+stream aggregate
dependencies: none (all infrastructure exists)
files:
  - packages/quereus/src/planner/nodes/hash-aggregate.ts (new)
  - packages/quereus/src/planner/nodes/stream-aggregate.ts (reference)
  - packages/quereus/src/planner/nodes/plan-node-type.ts (PlanNodeType.HashAggregate already exists)
  - packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts (refactor to cost-based selection)
  - packages/quereus/src/planner/cost/index.ts (add hash aggregate cost constants/functions)
  - packages/quereus/src/runtime/emit/hash-aggregate.ts (new)
  - packages/quereus/src/runtime/emit/aggregate.ts (reference — stream aggregate emitter)
  - packages/quereus/src/runtime/register.ts (register hash aggregate emitter)
  - packages/quereus/src/util/key-serializer.ts (reuse serializeKeyNullGrouping)
  - packages/quereus/src/planner/validation/plan-validator.ts (already allows HashAggregate)
  - docs/optimizer.md (update Aggregation section)
----

## Overview

Add a `HashAggregateNode` physical operator that builds a hash map keyed by GROUP BY columns, accumulates aggregate state per group, and emits all groups at the end. The optimizer rule selects between hash aggregate and sort+stream aggregate based on cost.

## Architecture

### HashAggregateNode (plan node)

Mirror `StreamAggregateNode` structure with key differences:

- **No ordering requirement**: input can be unsorted
- **No ordering output**: `computePhysical()` returns no `ordering` (hash doesn't preserve order)
- **Same unique key semantics**: GROUP BY columns form `uniqueKeys`, global aggregate produces `[[]]`
- **Cost model**: `inputRows * HASH_AGG_BUILD_PER_ROW + estimatedGroups * HASH_AGG_PER_GROUP`

Constructor shape matches `StreamAggregateNode`: `(scope, source, groupBy, aggregates, estimatedCostOverride?, preserveAttributeIds?)`

### emitHashAggregate (runtime emitter)

Uses the existing `serializeKeyNullGrouping` from `key-serializer.ts` for GROUP BY key hashing. This correctly handles NULL grouping (SQL standard: NULLs are equal in GROUP BY).

**Build phase**: iterate all source rows, for each row:
1. Evaluate GROUP BY expressions to get group key values
2. Serialize via `serializeKeyNullGrouping` → string key
3. Look up or create group entry in `Map<string, GroupState>`
4. Evaluate aggregate argument expressions
5. Handle DISTINCT tracking per aggregate (BTree, same as stream)
6. Call step functions on accumulators

**Emit phase**: iterate all groups in the map:
1. Finalize each accumulator
2. Build output row: [groupValues..., aggregateResults...]
3. Set up combined context (output + representative source row) for HAVING
4. Yield the row

**GroupState** shape:
```typescript
interface GroupState {
  groupValues: SqlValue[];
  accumulators: AggValue[];
  distinctTrees: (BTree | null)[];
  representativeSourceRow: Row;
}
```

**No GROUP BY case**: identical to stream aggregate (single accumulator, no hash map needed). Can delegate to the same code path or inline.

The emitter should reuse the same patterns from `emitStreamAggregate` for:
- Pre-resolving aggregate schemas and distinct flags
- Pre-computing skip-coercion flags
- Pre-resolving collation normalizers for key serialization
- Context management (scanRowDescriptor, combinedRowDescriptor, etc.)

### Cost-based rule selection

Refactor `ruleAggregateStreaming` into a cost-based selection rule (rename to `ruleAggregatePhysical`).

**Decision logic**:
```
sourceOrdering = PlanNodeCharacteristics.getOrdering(source)
alreadySorted = isOrderedForGrouping(sourceOrdering, groupingKeys, sourceAttributes)

streamCost = alreadySorted
  ? aggregateCost(inputRows, outputRows)  // no sort needed
  : sortCost(inputRows) + aggregateCost(inputRows, outputRows)

hashCost = hashAggregateCost(inputRows, estimatedGroups)

if (groupingKeys.length === 0)
  → always StreamAggregate (no hash needed for scalar aggregate)
else if (alreadySorted)
  → always StreamAggregate (no sort overhead, preserves ordering)
else
  → choose cheaper of stream (with sort) vs hash
```

When input is already sorted, stream aggregate is strictly better: same processing cost, plus preserves output ordering which downstream operators (ORDER BY) can exploit.

### Cost model additions

Add to `cost/index.ts`:
```typescript
HASH_AGG_BUILD_PER_ROW: 0.5   // per-row hashing + map insertion
HASH_AGG_PER_GROUP: 1.0       // per-group finalization overhead

function hashAggregateCost(inputRows: number, estimatedGroups: number): number
function streamAggregateCost(inputRows: number, outputRows: number): number
```

The stream aggregate per-row cost (0.1 in current `StreamAggregateNode`) is cheaper than hash (0.5) because it avoids hash computation and map lookups. But sort+stream adds `sortCost(n) = n * log2(n) * 2.0` which grows superlinearly.

Crossover: hash wins when `inputRows * 0.5 + groups * 1.0 < inputRows * log2(inputRows) * 2.0 + inputRows * 0.1 + groups * 1.5`. For any non-trivial input size (>10 rows), the sort cost dominates, so hash aggregate should be preferred for unsorted inputs.

### Physical properties

- **ordering**: `undefined` (hash aggregate does NOT preserve input ordering)
- **uniqueKeys**: same as stream aggregate — GROUP BY column indices, or `[[]]` for global
- **estimatedRows**: same formula as stream aggregate

## Key tests (for later review phase)

- Basic GROUP BY with hash aggregate (unsorted input, verify correct grouping)
- NULL grouping: `GROUP BY` with NULL values groups them together
- DISTINCT aggregates: `SELECT grp, COUNT(DISTINCT val) FROM t GROUP BY grp`
- HAVING clause works with hash aggregate
- Scalar aggregate (no GROUP BY) still uses stream aggregate
- Already-sorted input uses stream aggregate (verify via EXPLAIN or plan inspection)
- Multiple aggregate functions in same query
- Empty input produces correct results (no groups → no rows for GROUP BY, one row for scalar)
- GROUP BY on multiple columns
- Collation-aware grouping (NOCASE collation on text GROUP BY column)
- Correlated subqueries in HAVING with hash aggregate

## TODO

### Phase 1: Plan node + cost model
- Add `HASH_AGG_BUILD_PER_ROW` and `HASH_AGG_PER_GROUP` constants and `hashAggregateCost()` / `streamAggregateCost()` functions to `cost/index.ts`
- Create `HashAggregateNode` in `planner/nodes/hash-aggregate.ts`, mirroring `StreamAggregateNode` but without ordering output in `computePhysical()`

### Phase 2: Runtime emitter
- Create `emitHashAggregate` in `runtime/emit/hash-aggregate.ts`
- Register in `runtime/register.ts` (replace the TODO comment)

### Phase 3: Optimizer rule
- Refactor `ruleAggregateStreaming` → cost-based selection between `StreamAggregateNode` (with sort if needed) and `HashAggregateNode`
- Rename rule ID to `aggregate-physical` in `optimizer.ts`

### Phase 4: Documentation
- Update `docs/optimizer.md` Aggregation section to describe both operators and cost-based selection
- Update `planner/rules/aggregate/` — rename file if warranted, update JSDoc header

### Phase 5: Build + test
- Verify build passes
- Run existing aggregate tests (they should pass unchanged since stream aggregate is still used when optimal)
- Run full test suite
