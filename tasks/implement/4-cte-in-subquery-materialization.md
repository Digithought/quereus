---
description: Materialize IN-subquery results to eliminate per-row re-execution in filter predicates
dependencies: CacheNode infrastructure (planner/nodes/cache-node.ts, runtime/cache/shared-cache.ts), characteristics framework
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

## Solution: Planner-level CacheNode wrapping for uncorrelated IN subqueries

Instead of adding emit-time caching inside `emitIn`, inject a `CacheNode` around the IN-subquery's source during planning. This reuses the existing `CacheNode` + `shared-cache` infrastructure — the source is materialized into `Row[]` on first iteration and replayed from cache on subsequent passes.

### Approach

A new optimizer rule (or extension to `rule-cte-optimization`) inspects `InNode` instances whose `source` is:
- Uncorrelated (no outer attribute references)
- Deterministic / functional (`PlanNodeCharacteristics.isFunctional`)

When both hold, wrap `InNode.source` in a `CacheNode`. The existing `emitIn` streaming path then naturally iterates the cached rows on every evaluation instead of re-executing the full subquery.

### Interaction with subquery decorrelation

This task and the decorrelation task (semi/anti joins) cleanly partition the problem space:
- **This task:** Uncorrelated IN-subquery → `CacheNode` wrapping (source materializes once)
- **Decorrelation:** Correlated EXISTS/IN → rewrite to semi/anti join (eliminates the subquery entirely)

Correlated subqueries fail the uncorrelated gate and are left alone for the decorrelation rule.

### Key files

| File | Role |
|------|------|
| `src/planner/rules/cache/rule-cte-optimization.ts` | Extend or sibling rule — inject CacheNode on InNode.source |
| `src/planner/nodes/cache-node.ts` | Existing CacheNode infrastructure |
| `src/runtime/cache/shared-cache.ts` | Existing shared cache runtime |
| `src/planner/nodes/subquery.ts` | `InNode` — source to be wrapped |
| `src/planner/framework/characteristics.ts` | Determinism / functional checks |
| `src/planner/cache/correlation-detector.ts` | Existing — verify uncorrelated |
| `test/logic/13.1-cte-multiple-recursive.sqllogic` | Existing correctness tests |

### Performance impact

| Scenario | Before | After |
|----------|--------|-------|
| 60 entities, tree depth 5 | O(60 * 60) = 3,600 CTE row evals | O(60) CTE row evals + O(60) cached replays |
| N entities, K tree size | O(N * K) | O(K + N * K_cached) where K_cached is a memory scan |

Note: `CacheNode` materializes into `Row[]` (linear scan per IN evaluation), not a BTree. For large subquery results this is O(K) per outer row instead of O(log K). This is acceptable — the dominant cost was re-executing the CTE, not the lookup. If profiling shows the linear scan matters, a future optimization can add a hash-set variant to `CacheNode`.

### Testing

- Existing tests in `13.1-cte-multiple-recursive.sqllogic` cover correctness for the exact query pattern
- Add test for IN-subquery with NULLs in the subquery result set
- Add test for correlated IN subquery (must NOT get CacheNode) to verify gate
- Verify existing `07.6-subqueries.sqllogic` tests still pass

## TODO

- Add optimizer rule to wrap uncorrelated, deterministic `InNode.source` in `CacheNode`
- Gate on: uncorrelated (no outer refs) AND deterministic/functional
- Keep streaming path unchanged — CacheNode is transparent to `emitIn`
- Add sqllogic tests for NULL handling in IN-subquery with materialization
- Verify existing tests pass
