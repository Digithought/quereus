---
description: Materialize IN-subquery results to eliminate per-row re-execution in filter predicates
dependencies: Instruction emission system, BTree (inheritree), physical characteristics framework
---

## Problem

When `IN (SELECT col FROM source)` appears inside a filter predicate (WHERE clause), the subquery is re-executed for every outer row. This is because filter predicates are compiled via `emitCallFromPlan`, creating a `Scheduler` program that runs from scratch for each row evaluation.

For the motivating query:

```sql
WITH RECURSIVE
  entity_tree(id) AS (
    SELECT id FROM Entity WHERE id = ?
    UNION ALL
    SELECT E.id FROM Entity E JOIN entity_tree T ON E.component_id = T.id
  ),
  ancestor_walk(entity_id, ancestor_id, depth) AS (
    SELECT E.id, E.component_id, 0
    FROM Entity E
    WHERE E.id IN (SELECT id FROM entity_tree) AND E.component_id IS NOT NULL
    ...
  )
```

The `ancestor_walk` base case filter `E.id IN (SELECT id FROM entity_tree)` causes the entire `entity_tree` recursive CTE to be re-executed for every row in the Entity table scan. With N entities and a tree of size K, this is O(N * K) CTE evaluations instead of O(K + N).

### Root cause trace

1. `emitFilter` (`runtime/emit/filter.ts:20`) compiles the predicate with `emitCallFromPlan`
2. `emitCallFromPlan` (`runtime/emitters.ts:149-152`) wraps the predicate's instruction tree in a `Scheduler`, returning a callback
3. The filter calls `predicate(rctx)` → `program.run(rctx)` for each source row (filter.ts:30)
4. Each `program.run()` re-evaluates all instructions from scratch, including the IN subquery's source param
5. `emitIn` (`runtime/emit/subquery.ts:75`) uses `emitPlanNode(plan.source, ctx)` as a regular param — so the CTE source is a fresh `AsyncIterable` on every call
6. The streaming `runSubqueryStreaming` iterates through the full CTE result for each evaluation

## Solution: Emit-time set materialization for uncorrelated IN subqueries

In `emitIn` (subquery path), add **closure-level caching**: materialize the subquery result into a `BTree` on the first evaluation and reuse it for all subsequent evaluations.

### Key files

| File | Role |
|------|------|
| `packages/quereus/src/runtime/emit/subquery.ts` | Primary change — `emitIn` subquery path |
| `packages/quereus/src/planner/nodes/subquery.ts` | `InNode` — may need a `deterministic` flag |
| `packages/quereus/src/planner/framework/characteristics.ts` | `PlanNodeCharacteristics.isDeterministic` |
| `packages/quereus/test/logic/13.1-cte-multiple-recursive.sqllogic` | Existing correctness tests |

### Implementation

In `emitIn`, when handling `plan.source` (the IN-subquery variant):

1. **Gate on determinism**: Check if `plan.source` is deterministic and read-only (`PlanNodeCharacteristics.isFunctional(plan.source)`). Uncorrelated subqueries over CTEs and base tables qualify.

2. **Add closure-level BTree cache**: Create a `BTree<SqlValue, SqlValue>` in the emitter closure (not inside `run`). On first `run` invocation, populate the BTree from the subquery iterable and record whether NULLs were present. On subsequent invocations, skip the subquery iterable entirely and use BTree `find()`.

3. **Preserve NULL semantics**: SQL `IN` with NULLs requires: if condition is NULL → NULL; if match found → TRUE; if any subquery value was NULL and no match → NULL; otherwise → FALSE. The BTree excludes NULL values; a separate `hasNull` flag handles the NULL case.

Pseudocode for the new path:

```typescript
// Closure state — shared across all invocations of this instruction
let cachedTree: BTree<SqlValue, SqlValue> | null = null;
let cachedHasNull = false;

async function runMaterialized(_rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
    // Materialize on first call
    if (!cachedTree) {
        cachedTree = new BTree<SqlValue, SqlValue>(v => v, (a, b) => compareSqlValuesFast(a, b, collation));
        for await (const row of input) {
            if (row.length > 0) {
                if (row[0] === null) { cachedHasNull = true; continue; }
                cachedTree.insert(row[0]);
            }
        }
    }
    // Lookup (same NULL semantics as streaming path)
    if (condition === null) return null;
    if (cachedTree.find(condition).on) return true;
    return cachedHasNull ? null : false;
}
```

The existing streaming path (`runSubqueryStreaming`) remains as fallback for correlated/non-deterministic subqueries.

### Performance impact

| Scenario | Before | After |
|----------|--------|-------|
| 60 entities, tree depth 5 | O(60 * 60) = 3,600 CTE row evals | O(60) CTE row evals + O(60 * log 60) lookups |
| N entities, K tree size | O(N * K) | O(K + N * log K) |

### Testing

- Existing tests in `13.1-cte-multiple-recursive.sqllogic` cover correctness for the exact query pattern
- Add performance-oriented test with larger dataset (100+ entities) to verify no regression
- Add test for IN-subquery with NULLs in the subquery result set
- Add test for correlated IN subquery (must NOT use caching) to verify fallback path

## TODO

- Add `isFunctional` (or equivalent) check to `InNode` source during planning, or check at emit time
- Implement closure-level BTree caching in `emitIn` subquery path, gated on determinism
- Keep streaming path as fallback for non-deterministic/correlated sources
- Add sqllogic tests for NULL handling in IN-subquery with materialization
- Verify existing `13.1-cte-multiple-recursive.sqllogic` tests still pass
