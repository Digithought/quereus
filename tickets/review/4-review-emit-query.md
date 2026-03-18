description: Systematic review of runtime emitters for query operations
dependencies: none
files:
  packages/quereus/src/runtime/emit/scan.ts
  packages/quereus/src/runtime/emit/filter.ts
  packages/quereus/src/runtime/emit/project.ts
  packages/quereus/src/runtime/emit/alias.ts
  packages/quereus/src/runtime/emit/sort.ts
  packages/quereus/src/runtime/emit/limit-offset.ts
  packages/quereus/src/runtime/emit/distinct.ts
  packages/quereus/src/runtime/emit/retrieve.ts
  packages/quereus/src/runtime/emit/values.ts
  packages/quereus/src/runtime/emit/column-reference.ts
  packages/quereus/src/runtime/emit/literal.ts
  packages/quereus/src/runtime/emit/empty-result.ts
  packages/quereus/src/runtime/emit/join.ts
  packages/quereus/src/runtime/emit/bloom-join.ts
  packages/quereus/src/runtime/emit/merge-join.ts
  packages/quereus/src/runtime/emit/aggregate.ts
  packages/quereus/src/runtime/emit/hash-aggregate.ts
  packages/quereus/src/runtime/emit/window.ts
  packages/quereus/src/runtime/emit/window-function.ts
  packages/quereus/src/runtime/emit/subquery.ts
  packages/quereus/src/runtime/emit/cte.ts
  packages/quereus/src/runtime/emit/cte-reference.ts
  packages/quereus/src/runtime/emit/recursive-cte.ts
  packages/quereus/src/runtime/emit/internal-recursive-cte-ref.ts
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/src/runtime/emit/cache.ts
  packages/quereus/src/runtime/emit/table-valued-function.ts
  packages/quereus/src/runtime/emit/sequencing.ts
  packages/quereus/src/runtime/emit/sink.ts
  packages/quereus/src/runtime/emit/remote-query.ts
  packages/quereus/src/runtime/emit/array-index.ts
----
Review runtime emitters for query operations: scan, filter, project, sort, limit/offset, distinct, joins (nested-loop, bloom, merge), aggregates (stream, hash), window functions, CTEs (regular, recursive), subqueries, set operations, cache, and other query-path emitters.

Key areas of concern:
- AsyncIterator protocol compliance (yield, return, throw)
- Resource cleanup in finally blocks (cursor close, iterator return)
- Null handling in all operations
- Join emitters — outer join null row generation, predicate evaluation
- Aggregate emitters — empty group handling, DISTINCT aggregate dedup
- Window emitter — frame computation, peer detection, running aggregates
- Recursive CTE — termination, working table swap
- Sort — stability, memory management for large sorts
- Subquery — correlation variable binding, re-evaluation

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
