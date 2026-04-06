description: Unit tests for cost model functions verifying monotonicity, relative ordering, and boundary behavior
dependencies: none
files:
  - packages/quereus/src/planner/cost/index.ts
  - packages/quereus/test/planner/cost.spec.ts (new)
----

## Motivation

`planner/cost/` has 87% line coverage but only 44% function coverage. Half the cost functions are never called in tests. Bad cost estimates lead to the optimizer choosing poor plans — a class of bug that doesn't crash but silently degrades performance.

## What to test

### Individual cost functions — boundary and monotonicity

For each of `seqScanCost`, `indexSeekCost`, `indexScanCost`, `sortCost`, `filterCost`, `projectCost`, `aggregateCost`, `hashAggregateCost`, `streamAggregateCost`, `nestedLoopJoinCost`, `mergeJoinCost`, `hashJoinCost`, `distinctCost`, `limitCost`, `cacheCost`:

- **Zero rows**: cost ≥ 0, no NaN, no Infinity
- **One row**: cost > 0
- **Monotonicity**: cost(100 rows) > cost(10 rows) (more data → higher cost)
- **Large input**: 1M rows — no overflow, no NaN

### Relative cost ordering (the optimizer depends on these)

- `indexSeekCost` < `indexScanCost` < `seqScanCost` for same row count
- `mergeJoinCost` < `nestedLoopJoinCost` for large inputs
- `hashJoinCost` < `nestedLoopJoinCost` for large inputs
- `streamAggregateCost` < `hashAggregateCost` when input is pre-sorted (fewer groups)
- `limitCost` with small limit < cost without limit

### chooseCheapest()

- Returns the option with minimum cost
- Ties: returns first option (or verify contract)
- Single option: returns it
- Empty options: verify behavior (error or undefined)

### Join cost accuracy

- `nestedLoopJoinCost`: cost scales with outer × inner
- `hashJoinCost`: build cost proportional to smaller side
- `mergeJoinCost`: cost proportional to sum of inputs (not product)

### Edge cases

- Fractional row estimates (e.g. 0.5 estimated rows after selectivity)
- Very large row counts (1e9) — no numeric overflow
- Negative row counts (shouldn't happen, but verify no NaN)
