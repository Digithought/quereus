description: Tests for under-covered planner analysis, optimizer rules, stats, and plan nodes
files:
  packages/quereus/test/optimizer/predicate-normalizer.spec.ts
  packages/quereus/test/optimizer/statistics-edge-cases.spec.ts
  packages/quereus/test/optimizer/cache-rules.spec.ts
  packages/quereus/test/optimizer/plan-shape-decisions.spec.ts
  packages/quereus/test/logic/100-predicate-normalization-edge-cases.sqllogic
----

## What was built

83 new tests across 5 files covering planner/optimizer code:

### 1. Predicate normalizer tests (`test/optimizer/predicate-normalizer.spec.ts`) — 16 tests
- De Morgan's law with AND and OR
- Double negation elimination
- NOT pushdown on all comparison operators (>, >=, <, <=)
- OR flattening and OR-to-IN collapse
- AND flattening
- NOT BETWEEN
- Deeply nested De Morgan
- NULL handling with NOT (IS NULL / IS NOT NULL)
- Tautology and contradiction edge cases

### 2. Statistics edge cases (`test/optimizer/statistics-edge-cases.spec.ts`) — 38 tests
**Histogram (12 tests):** Single-value, all-duplicate, string values, bucket boundary, out-of-range, zero totalRows, <= and >= operators, == alias
**CatalogStatsProvider (26 tests):** Zero rowCount, no column ref, unknown node type, IN selectivity (normal + clamped), BETWEEN with/without histogram, <> alias, IS NULL/NOT NULL edge cases, all-null column, join selectivity fallback, index selectivity delegation

### 3. Cache & optimizer rules (`test/optimizer/cache-rules.spec.ts`) — 15 tests
**Distinct elimination (5):** PK elimination, non-unique kept, unique index, multi-column with PK, correctness
**Streaming vs hash aggregate (2):** ORDER BY matches GROUP BY, partial sort
**IN-subquery caching (5):** Uncorrelated cached, correlated not cached, value-list IN, correctness
**Mutating subquery (3):** Join with side effects, correctness

### 4. Plan shape decisions (`test/optimizer/plan-shape-decisions.spec.ts`) — 14 tests
**Predicate pushdown (2):** Filter below join, filter into subquery
**CTE materialization (3):** Single-use inlined, multi-use materialized, recursive CTE
**Limit/Offset (4):** Ordering preserved, offset, LIMIT 0, offset beyond rows
**Delete node (2):** WHERE clause delete, delete all
**Table function call (3):** query_plan TVF, schema() TVF, result content

### 5. SQLLogic normalization tests (`test/logic/100-predicate-normalization-edge-cases.sqllogic`)
18 SQL correctness tests covering all normalization transformations end-to-end.

## Coverage improvements

| File | Before Branch% | After Branch% |
|------|-------|--------|
| predicate-normalizer.ts | 70% | 87.8% |
| catalog-stats.ts | 62% | 77.8% |
| histogram.ts | 67% | 78.3% |
| rule-distinct-elimination.ts | 66% | 85.7% |
| rule-in-subquery-cache.ts | 63% | 63.6% |
| rule-aggregate-streaming.ts | 70% | 70.8% |

## Validation

- All 83 new tests pass individually
- Full test suite: 1538 passing, 2 pending (pre-existing)
- No regressions introduced

## Testing notes

- Run individual suites: `node test-runner.mjs --grep "Predicate normalizer"`, `--grep "Histogram edge"`, `--grep "CatalogStatsProvider"`, `--grep "Cache rules"`, `--grep "Plan shape"`
- Full suite: `cd packages/quereus && node test-runner.mjs`
- Coverage: `cd packages/quereus && yarn test:coverage`
