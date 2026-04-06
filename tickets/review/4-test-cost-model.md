description: Unit tests for cost model functions verifying monotonicity, relative ordering, and boundary behavior
dependencies: none
files:
  - packages/quereus/src/planner/cost/index.ts
  - packages/quereus/test/planner/cost.spec.ts (new)
----

## What was built

New test file `packages/quereus/test/planner/cost.spec.ts` with 90 tests covering all exported cost functions.

### Coverage

- **Unary cost functions** (seqScanCost, indexSeekCost, indexScanCost, sortCost, filterCost, distinctCost): zero rows, one row, monotonicity, large input (1M), very large input (1e9), fractional rows
- **Multi-param functions** (projectCost, aggregateCost, hashAggregateCost, streamAggregateCost, limitCost, cacheCost): boundary, monotonicity in each dimension, parameter effects
- **Join cost functions** (nestedLoopJoinCost, mergeJoinCost, hashJoinCost): boundary, scaling behavior (product vs sum), sort cost impact, build-side proportionality
- **Relative ordering**: indexSeek < indexScan < seqScan; merge/hash join < nested loop; stream agg < hash agg; limit < full scan
- **chooseCheapest()**: min cost, ties (first wins), single option, empty throws
- **Edge cases**: fractional rows, 1e9 rows, negative rows (no NaN)

### Testing notes

Run with: `yarn workspace @quereus/quereus test --grep "Cost model"`

Key validation patterns:
- `expectValidCost()` helper asserts finite, non-negative number
- Relative ordering tests use multiple row counts (10, 100, 1K, 10K) to ensure the relationship holds across scales
- Join cost accuracy tests verify the mathematical complexity class (product vs sum)
