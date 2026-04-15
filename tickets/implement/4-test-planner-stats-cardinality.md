---
description: Raise branch coverage on `src/planner/stats/` (currently 64.8% branches, 51.1% lines, 40.3% functions — the lowest-branch-coverage directory in the codebase). Covers row estimation, histogram selectivity, catalog stats provider, and naive fallback provider.
dependencies: none
files:
  packages/quereus/src/planner/stats/basic-estimates.ts
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/src/planner/stats/histogram.ts
  packages/quereus/src/planner/stats/index.ts
  packages/quereus/src/planner/stats/analyze.ts
  packages/quereus/test/planner/stats/basic-estimates.spec.ts
  packages/quereus/test/planner/stats/histogram.spec.ts
  packages/quereus/test/planner/stats/catalog-stats.spec.ts
  packages/quereus/test/logic/108-cardinality-estimation.sqllogic
  packages/quereus/docs/optimizer.md
---

## Context

From the latest `yarn test:coverage` run:

| Dir | Lines | Branches | Funcs |
|---|---|---|---|
| `planner/stats` | 51.1% | **64.8%** | 40.3% |

This is the lowest branch-coverage directory in the planner and feeds directly into every cost-based optimizer decision. Wrong cardinality estimates produce worse plans — but tests usually pass because the result set is still correct, so mutants in this code survive silently. Bad cardinality is also a class of bug that property-based tests don't catch.

Key files and the branches that are thin:

### `basic-estimates.ts` (107 lines)
- `BasicRowEstimator.estimateJoin` — one branch per join type (`inner`, `left/left outer`, `right/right outer`, `full/full outer`, `cross`, default). Each branch uses a different formula; none is currently hit by a focused test.
- `BasicRowEstimator.estimateAggregate` — zero-group-by branch (scalar agg = 1 row) vs grouped branch with the `Math.min(0.8, Math.max(0.1, ...))` clamp
- `BasicRowEstimator.estimateFilter` — the 30% selectivity constant and the `Math.max(1, ...)` floor
- `BasicRowEstimator.estimateLimit` — underflow (`offset > limit`), zero-row source, limit exceeding source
- `ensureRowEstimate` — idempotent branch (already-set case)

### `catalog-stats.ts` (348 lines)
- `CatalogStatsProvider` predicate interpretation: `extractColumnFromPredicate`, `extractConstantValue`, `extractInListSize`, `extractBetweenBounds`, `extractEquiJoinColumns`
- Each of these returns `undefined` for unsupported predicate shapes — that fallback branch is what most mutants survive on

### `histogram.ts` (164 lines)
- `selectivityFromHistogram` — equal-to, range, open-ended-range branches
- `buildHistogram` — bucket boundary logic, degenerate cases (single bucket, all-same-value input, empty input)
- `findBucket` — binary search boundaries
- `interpolateCumulative` — boundary vs interior positions

### `index.ts` (158 lines)
- `NaiveStatsProvider` fallback for each stats query method
- `createStatsProvider` factory — which provider is chosen under which tuning

### `analyze.ts` (134 lines)
- `ANALYZE` statement execution path — full-table sampling, histogram population

## Test strategy

Two parallel tracks — both needed because cardinality ≠ correctness:

**Unit tests** — `test/planner/stats/basic-estimates.spec.ts`, `histogram.spec.ts`, `catalog-stats.spec.ts` (new directory). Direct calls to each estimator with hand-built inputs, asserting exact numeric outputs to three significant figures. Unit tests are the only practical way to assert "this join estimate is 5000" since sqllogic can't inspect plan cardinality without relying on fragile plan-shape matches.

**SQL logic** — `test/logic/108-cardinality-estimation.sqllogic`: ANALYZE-driven end-to-end. Populate a table, run `ANALYZE`, then run queries whose plans depend on accurate histograms (e.g. an index pick that is only correct if the selectivity estimate is under a threshold). Use `explain` + `plan like` to assert the chosen access method.

### Unit test targets (exact values)

```ts
describe('BasicRowEstimator', () => {
  const tuning = { defaultRowEstimate: 1000 } as OptimizerTuning;
  const est = new BasicRowEstimator(tuning);

  it('inner join applies 10% correlation', () => {
    expect(est.estimateJoin(100, 200, 'inner')).toBe(2000);
  });

  it('left outer never goes below left side', () => {
    expect(est.estimateJoin(100, 5, 'left')).toBe(100);
    expect(est.estimateJoin(100, 200, 'left outer')).toBe(2000);
  });

  it('cross join is exact cartesian', () => {
    expect(est.estimateJoin(7, 11, 'cross')).toBe(77);
  });

  // ... one case per branch
});
```

### Sqllogic targets (plan-shape)

- `ANALYZE` populates histograms that cause an index scan to be picked for a high-selectivity equality and a sequential scan for a low-selectivity range — assert via `explain`
- Multi-column equi-join where cardinality ordering determines which side is the build side
- Histogram-driven selectivity for `BETWEEN`, `IN` (small vs large list)

## Validation loop

```bash
cd packages/quereus
yarn test
yarn test:coverage
# Inspect coverage/quereus/src/planner/stats/ HTML report
```

Target: raise `planner/stats` branch coverage from 64.8% to ≥85%, line coverage from 51.1% to ≥80%.

## TODO

- [ ] Create `test/planner/stats/` directory with one spec per source file
- [ ] `basic-estimates.spec.ts` — one test per join type, aggregate grouping cases, filter floor, limit underflow, `ensureRowEstimate` idempotency
- [ ] `histogram.spec.ts` — selectivity for equal/range/open-range, bucket boundary conditions, degenerate inputs
- [ ] `catalog-stats.spec.ts` — each predicate extractor helper on supported and unsupported shapes
- [ ] Check whether `NaiveStatsProvider` needs its own spec or can be exercised via catalog-stats
- [ ] Create `test/logic/108-cardinality-estimation.sqllogic` — ANALYZE + plan-shape assertions
- [ ] Document chosen `ANALYZE` workflow in `docs/optimizer.md` if not already
- [ ] Re-run `yarn test:coverage` and verify thresholds met
- [ ] Update `docs/zero-bug-plan.md` §6 with a new row for `planner/stats`
