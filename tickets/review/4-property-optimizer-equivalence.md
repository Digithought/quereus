description: Differential testing — optimizer rule on vs off produces identical results
files:
  packages/quereus/test/fuzz.spec.ts
  packages/quereus/src/planner/optimizer-tuning.ts
  packages/quereus/src/planner/framework/registry.ts
  packages/quereus/src/planner/optimizer.ts
----

## What was built

Added a new `Optimizer Equivalence` describe block in `fuzz.spec.ts` (Phase 5) that runs
differential property-based tests to verify optimizer rewrite rules produce identical results
when enabled vs disabled.

### Mechanism

For each test, two Database instances are created — one with default tuning (all rules) and
one with specific rules disabled via `OptimizerTuning.disabledRules`. Both are seeded with
identical schema and data (verified at insert time). The same random queries are run on both
and results are compared order-independently.

Comparison logic:
- Both error → OK (both-null)
- One errors → Bug (optimizer rule broke or enabled a query)
- Both succeed → Row sets must be identical (sorted by JSON serialization)

### Tests added (6 total)

1. **predicate pushdown rules** — disables `predicate-pushdown`, `filter-merge`
2. **join rewrite rules** — disables `join-greedy-commute`, `join-key-inference`
3. **subquery decorrelation** — disables `subquery-decorrelation`
4. **cache/CTE rules** — disables `cte-optimization`, `in-subquery-cache`, `mutating-subquery-cache`, `scalar-cse`; uses mix of CTE and SELECT queries
5. **distinct elimination** — disables `distinct-elimination`
6. **all rewrite rules disabled** (catch-all) — disables all of the above plus `projection-pruning`; uses SELECT, CTE, and window function queries

### Design decisions

- Only rewrite-phase rules are tested (not impl-phase rules like `aggregate-physical`,
  `join-physical-selection`, `select-access-path`) because disabling impl rules prevents
  physical plan generation entirely, causing expected failures rather than result mismatches
- 25 numRuns per category test, 20 for the catch-all (each run creates 2 databases)
- 5-15 rows per table, 5 queries per run to keep execution fast
- Seeding verifies both databases agree on each insert to ensure identical data state

### Testing notes

- All 6 new tests pass
- Full test suite: 1708 passing, 3 pending (pre-existing skips)
- No type errors

### Usage

```bash
yarn workspace @quereus/quereus test --grep "Optimizer Equivalence"
```
