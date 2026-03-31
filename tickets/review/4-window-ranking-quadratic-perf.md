description: Optimized O(n^2) window ranking functions (RANK, DENSE_RANK, PERCENT_RANK, CUME_DIST) to O(n)
dependencies: none
files:
  packages/quereus/src/runtime/emit/window.ts
----
## Summary

Replaced per-row O(n^2) ranking computations with a single O(n) pre-pass over sorted partition rows.

### What changed

- Added `PrecomputedRankings` interface and `precomputeRankings()` function that does a single linear scan over `orderByValues` to detect peer group boundaries using the existing `arePeerRows()` helper, computing RANK, DENSE_RANK, PERCENT_RANK, and CUME_DIST for all rows in one pass.
- `processPartition` now calls `precomputeRankings` once after sorting, before the per-row loop.
- `computeRankingFunction` simplified to O(1) lookups into the pre-computed arrays (except NTILE which was already O(1)).
- Removed `computeRank()`, `areRowsEqualInOrderBy()`, `getOrderByKey()` — all were O(n) helpers called per-row, causing the quadratic behavior. They are fully replaced by the pre-pass.
- Removed `orderByKeyNormalizers` parameter chain (was only needed for `getOrderByKey` in the old dense_rank path).

### Key design points

- Uses the already-materialized `orderByValues` from `sortRows`, so no ORDER BY callbacks are re-evaluated.
- `arePeerRows()` (synchronous, uses pre-computed values) replaces `areRowsEqualInOrderBy()` (async, re-evaluated callbacks).
- ROW_NUMBER and NTILE unchanged — already O(1).

## Use cases for testing

- RANK with ties (same ORDER BY values should get same rank, with gaps)
- DENSE_RANK with ties (same rank, no gaps)
- PERCENT_RANK edge cases (single-row partition → 0, ties)
- CUME_DIST (peer groups at partition boundaries)
- NTILE (unchanged, should still work)
- ROW_NUMBER (unchanged)
- Window functions with PARTITION BY + ORDER BY
- Window functions with COLLATION (NOCASE)
- NULL handling in ORDER BY
- Multiple window functions in same query
