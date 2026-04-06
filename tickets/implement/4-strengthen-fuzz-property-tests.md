description: Strengthen existing fuzz and property tests — add result validation, increase coverage breadth, fix generation gaps
dependencies: none
files:
  - packages/quereus/test/fuzz.spec.ts
  - packages/quereus/test/property-planner.spec.ts
----

## Motivation

The recently added fuzz and property tests are well-structured but have significant weaknesses that limit their bug-finding ability. The fuzzer only asserts "doesn't crash" — it would pass even if `COUNT(*)` returned -1. The property tests use tiny datasets (5–20 rows) and never test 3+ table queries. Both found zero bugs, and these changes should make them more likely to catch real issues.

## Changes to fuzz.spec.ts

### Add result validation (high priority)

The fuzzer currently only checks "no unexpected exception type." Add semantic checks:

1. **Determinism check**: run the same SELECT twice, assert identical results. This catches non-deterministic execution bugs without needing to know the expected answer.
2. **COUNT non-negative**: for any `SELECT count(*) FROM ...`, assert result ≥ 0.
3. **LIMIT enforcement**: for queries with `LIMIT N`, assert result set size ≤ N.
4. **ORDER BY sortedness**: for queries with `ORDER BY col ASC`, assert results are actually sorted.

These are invariant-based — they don't need expected values, just properties that must hold.

### Broaden SQL generation

- **Correlated subqueries**: the generator never produces correlated subqueries (all subqueries are independent SELECTs). Add generation of `WHERE col IN (SELECT ... FROM ... WHERE outer.col = inner.col)`.
- **Recursive CTEs**: currently only simple CTEs. Add `WITH RECURSIVE` generation with a depth bound.
- **Aggregate functions in generation**: add `group_concat`, `total`, date/time functions, JSON functions to the function pool.
- **LIKE/GLOB patterns**: add pattern-matching expressions.

### Fix generation biases

- **Negative floats**: seed data uses `Math.abs(n % 100)` — never negative. Remove the `abs`.
- **Substr position**: hardcoded to position 1. Randomize the start position.
- **Increase expression depth**: max 3 is very shallow. Increase to 5 for some percentage of runs.
- **Variable sample counts**: replace `fc.sample(arbs.select, 5)` with `fc.array` using `minLength: 3, maxLength: 10`.

## Changes to property-planner.spec.ts

### Verify rules actually fire (high priority)

The semantic equivalence tests only check that disabling a rule doesn't change results. A rule that never matches also passes. Add a companion assertion:

```typescript
// After getting planEnabled and planDisabled:
// Verify the plans are actually different (rule fired)
// If plans are identical, log a warning — the generated query didn't exercise the rule
```

This doesn't need to be a hard failure (some random schemas won't trigger every rule), but track the fire-rate and fail if a rule never fires across all numRuns.

### Increase data scale

- Bump row generation from `{ minLength: 5, maxLength: 20 }` to `{ minLength: 20, maxLength: 100 }`. Tiny datasets don't stress cardinality estimation or join order selection.
- Add a "large scale" variant with 500–1000 rows for a subset of tests (lower numRuns to compensate for runtime).

### Add skewed data distributions

All data is currently uniform random. Add:
- **High-cardinality skew**: 80% of rows have the same value in one column
- **Clustered NULLs**: one column is 90% null
- **Monotonic sequences**: column values 1, 2, 3, ... N

These stress the stats/histogram path and expose optimizer bugs with non-uniform data.

### Add multi-table queries

Currently only 2 tables. For join commutativity and rule equivalence tests, add a 3-table variant:
```sql
SELECT * FROM t1 JOIN t2 ON ... JOIN t3 ON ...
```
Test that 3-way join reordering preserves results.

### Add multi-column join conditions

Currently always `t1.id = t2.col`. Add:
```sql
t1.a = t2.a AND t1.b = t2.b
```
Multi-column join predicates stress different optimizer rule paths.

### Strengthen NULL algebra tests

The NULL algebra tests (property 5) are hardcoded SQL strings, not property-based. Parameterize:
- Generate random non-null values for COALESCE verification
- Generate random IN-lists with NULL at random positions
- Generate random column values to verify IS NULL / IS NOT NULL complementarity

## Testing

After changes, run the full suite and verify all existing tests still pass. If any new assertions catch real bugs, those are wins — file separate fix tickets for them.
