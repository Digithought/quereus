---
description: Materialize IN-subquery results to eliminate per-row re-execution in filter predicates
dependencies: CacheNode infrastructure, characteristics framework, correlation detector
---

## Summary

Added a new optimizer rule `ruleInSubqueryCache` that wraps uncorrelated, deterministic IN-subquery sources in a `CacheNode` during planning. This eliminates per-row re-execution of IN subqueries (including recursive CTEs) in filter predicates, reducing O(N * K) CTE evaluations to O(K + N * K_cached).

## Changes

### New file: `src/planner/rules/cache/rule-in-subquery-cache.ts`

New optimizer rule registered in `PostOptimization` pass (priority 25, between CTE optimization at 20 and materialization advisory at 30). The rule:

1. Guards on `InNode` with a subquery `source` (skips value-list IN)
2. Skips if source is already cached (`CapabilityDetectors.isCached`)
3. Skips if source is correlated (`isCorrelatedSubquery`)
4. Skips if source is non-functional (non-deterministic or has side effects)
5. Wraps `InNode.source` in a new `CacheNode` with memory strategy

### Modified: `src/planner/optimizer.ts`

Imported and registered the new rule.

### New test: `test/logic/07.7-in-subquery-caching.sqllogic`

Covers:
- Basic uncorrelated IN subquery (cached path)
- IN subquery with NULLs in subquery result set (three-valued logic)
- NOT IN with NULLs (all rows excluded per SQL spec)
- IN subquery returning empty set
- Correlated IN subquery (must still work correctly, not cached)
- Uncorrelated IN subquery referencing recursive CTE (motivating pattern)
- Nested: uncorrelated IN referencing recursive CTE with joins

## Testing

- All 666 quereus package tests pass (including 55 sqllogic test files)
- New test file covers NULL handling, correlated gate, and CTE-based patterns
- Existing `07.6-subqueries.sqllogic` and `13.1-cte-multiple-recursive.sqllogic` continue to pass
