description: Strengthened fuzz and property tests — added result validation, broader SQL generation, skewed data, multi-table queries, large-scale stress tests
dependencies: none
files:
  - packages/quereus/test/fuzz.spec.ts
  - packages/quereus/test/property-planner.spec.ts
----

## Summary

Strengthened both the grammar-based SQL fuzzer and property-based planner tests to increase their bug-finding ability beyond simple "doesn't crash" assertions.

## Changes to fuzz.spec.ts

### Result validation (4 new tests)
- **Determinism check**: runs each SELECT twice and asserts identical results row-by-row
- **COUNT non-negative**: asserts `COUNT(*)` >= 0 for every generated table
- **LIMIT enforcement**: asserts result set size <= N for `LIMIT N` queries
- **ORDER BY sortedness**: asserts ascending order for same-typed non-null consecutive values

### Broadened SQL generation
- **Correlated subqueries**: generates `col IN (SELECT ... WHERE outer.col = inner.col)` across two tables
- **Recursive CTEs**: generates `WITH RECURSIVE cnt(x) AS (...)` with bounded depth
- **LIKE/GLOB patterns**: generates pattern-matching expressions
- **More functions**: added `total` and `group_concat` to the scalar function pool
- **Expression depth**: increased max depth from 3 to 5

### Fixed generation biases
- **Substr position**: randomized start position (was hardcoded to 1)
- **Variable sample counts**: replaced fixed sample counts (e.g. 5) with random ranges (3-10) per property run

## Changes to property-planner.spec.ts

### Rule fire-rate tracking
- Each semantic equivalence test now compares plans with/without the rule; if plans never differ across all runs, emits `console.warn` identifying the untested rule
- Currently 5 rules flagged as never firing — these are candidates for improved query generation in future work

### Increased data scale
- Default row generation bumped from 5-20 to 20-100 rows
- New "Large-scale stress tests" suite with 500-1000 rows (5 runs each): join commutativity, aggregate invariants, and semantic equivalence at scale

### Skewed data distributions
- New `skewedDataArb` generator producing 3 distribution types:
  - High-cardinality skew: 80% of rows share the same value in one column
  - Clustered NULLs: 90% null in one column
  - Monotonic sequences: 1, 2, 3, ... N
- New "Semantic equivalence with skewed data" test suite for predicate-pushdown and distinct-elimination

### Multi-table queries
- **3-table join commutativity**: `t1 JOIN t2 JOIN t3` vs reordered, asserting same result set
- **Multi-column join conditions**: `t1.a = t2.a AND t1.b = t2.b` with commutativity check

### Strengthened NULL algebra tests
- `NULL IN (...)` now parameterized: random value lists with NULL at random position
- `COALESCE(NULL, v)` now tests floats and empty strings in addition to integers/strings (50 runs)
- `IS NULL / IS NOT NULL` now tests floats (50 runs)

## Testing

- Full test suite: 1172 passing, 2 pending, 0 failures
- fuzz.spec.ts: 9 tests (5 original + 4 new validation tests)
- property-planner.spec.ts: 27 tests (was ~20, now includes skewed data, 3-table joins, multi-column joins, large-scale stress)

## Use cases for review validation
- Verify the new fuzz validation tests catch real invariant violations (e.g. temporarily break LIMIT enforcement)
- Confirm large-scale stress tests complete within timeout (120s)
- Check that rule fire-rate warnings are accurate and actionable
- Ensure skewed data distributions actually produce the intended skew patterns
