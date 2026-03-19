description: Optimize O(n^2) window ranking functions (RANK, DENSE_RANK, PERCENT_RANK, CUME_DIST) to O(n)
dependencies: none
files:
  packages/quereus/src/runtime/emit/window.ts
----
## Problem

The window ranking function implementations in `emitWindow` have O(n^2) complexity per partition:

- `computeRank()` (line ~411): iterates from 0..currentIndex for every row, calling `areRowsEqualInOrderBy` which itself evaluates callbacks. Overall O(n^2) per partition.
- `dense_rank` (line ~338): similar O(n^2) scan with additional Set tracking.
- `percent_rank` delegates to `computeRank`, same issue.
- `cume_dist` (line ~385): scans forward from currentIndex on each row.

Since `processPartition` already has pre-computed `orderByValues` (from `sortRows`), the ranking functions could use those cached values instead of re-evaluating callbacks via `areRowsEqualInOrderBy`. A single linear pass over sorted rows can assign all rank values.

## Proposal

Refactor ranking computation to a pre-pass approach:
1. After sorting, make a single O(n) pass to detect peer group boundaries using `orderByValues`.
2. Assign RANK, DENSE_RANK, ROW_NUMBER, PERCENT_RANK, and CUME_DIST values in that pass.
3. Store computed values in an array indexed by row position.
4. Look up the pre-computed value during row emission.

This eliminates re-evaluation of ORDER BY callbacks and reduces all ranking functions from O(n^2) to O(n) per partition.

Severity: smell (performance) — correctness is fine, but large partitions will degrade significantly.
Source: review of aggregate/window plan nodes.
