description: Review coverage tests for `src/planner/stats/` — verify test quality, coverage thresholds, and doc updates.
dependencies: none
files:
  packages/quereus/test/planner/stats/basic-estimates.spec.ts
  packages/quereus/test/planner/stats/histogram.spec.ts
  packages/quereus/test/planner/stats/catalog-stats.spec.ts
  packages/quereus/test/planner/stats/index.spec.ts
  packages/quereus/test/logic/108-cardinality-estimation.sqllogic
  packages/quereus/src/planner/stats/basic-estimates.ts
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/src/planner/stats/histogram.ts
  packages/quereus/src/planner/stats/index.ts
  packages/quereus/src/planner/stats/analyze.ts
  docs/zero-bug-plan.md
---

## Summary

Raised branch coverage on `src/planner/stats/` from 64.8% to 92.6%, line coverage from 51.1% to 87.4%, and function coverage from 40.3% to 97.7%.

## What was built

### Unit tests (`test/planner/stats/`)

- **basic-estimates.spec.ts** — Tests all `BasicRowEstimator` methods:
  - `estimateFilter`: 30% selectivity, floor at 1 row
  - `estimateJoin`: all 7 branches (inner, left, left outer, right, right outer, full, full outer, cross, default), case-insensitive matching
  - `estimateAggregate`: scalar agg (0 groups = 1 row), grouping factor clamping [0.1, 0.8]
  - `estimateDistinct`: 70% heuristic
  - `estimateLimit`: offset subtraction, underflow (offset > limit), zero source, exceeding source
  - `getRowEstimate` and `ensureRowEstimate`: fallback to tuning, idempotency

- **histogram.spec.ts** — Tests `buildHistogram` and `selectivityFromHistogram`:
  - All operators: `=`, `==`, `<`, `<=`, `>`, `>=`, unsupported
  - Degenerate inputs: empty, single value, all-same
  - Boundary values: bucket boundaries, single-bucket histograms
  - String values, cumulative count monotonicity

- **catalog-stats.spec.ts** — Tests `CatalogStatsProvider`:
  - BinaryOp: `=`, `==`, `!=`, `<>`, `>`, `<`, `>=`, `<=`, `LIKE`, unsupported ops, no-op operator
  - UnaryOp: `IS NULL`, `IS NOT NULL`, unsupported unary
  - `In`: listSize/NDV, clamping at 1.0, fallback to children count
  - `Between`: with/without histogram, non-literal bounds, Promise literal values
  - Join: NDV-based, FK→PK (both directions), multi-column PK fallback, non-equi-join, non-column children
  - `distinctValues`: catalog lookup, case-insensitive, fallbacks
  - `indexSelectivity`: delegation and fallback
  - Fallback cases: zero rowCount, no stats, missing column, unknown nodeType

- **index.spec.ts** — Tests `NaiveStatsProvider`, `createStatsProvider`, `defaultStatsProvider`:
  - All predicate type heuristics (BinaryOp, In, Between, Like, IsNull, IsNotNull, default)
  - `joinSelectivity`: cap at 0.5, default row fallback
  - `distinctValues`: 50% heuristic, floor, undefined for 0 rows
  - `indexSelectivity`: 20% improvement
  - `createStatsProvider`: both maps, fallback behavior

### SQL logic test

- **108-cardinality-estimation.sqllogic** — End-to-end ANALYZE workflow:
  - Table setup with skewed distribution
  - ANALYZE execution, re-ANALYZE after data changes
  - Equality and range filter correctness post-ANALYZE
  - Inner and left join correctness

### Doc updates

- `docs/zero-bug-plan.md` §6: Added coverage improvement table for `planner/stats`

## Testing & validation

```bash
yarn workspace @quereus/quereus test     # 2293 passing, 0 failing
yarn workspace @quereus/quereus test:coverage  # planner/stats: 87.4% lines, 92.6% branches, 97.7% functions
```

## Coverage details

| File | Lines | Branches | Functions |
|---|---|---|---|
| basic-estimates.ts | 100% | 100% | 100% |
| catalog-stats.ts | 98.3% | 94.7% | 100% |
| histogram.ts | 100% | 86% | 100% |
| index.ts | 100% | 90% | 100% |
| analyze.ts | 18.7% | 100% | 0% |
| **Total** | **87.4%** | **92.6%** | **97.7%** |

Note: `analyze.ts` has low line coverage because it requires `VirtualTable.query()` integration — this is exercised through the existing ANALYZE integration tests in `test/optimizer/statistics.spec.ts` (via Database + MemoryTableModule).
