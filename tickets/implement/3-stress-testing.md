description: Stress tests for large datasets, deep queries, and concurrent access patterns
dependencies: none
files:
  - packages/quereus/test/stress.spec.ts (new)
  - packages/quereus/test/performance-sentinels.spec.ts (reference)
  - packages/quereus/test/property.spec.ts (reference)
  - packages/quereus/test-runner.mjs (reference)
----

## Overview

The existing test suite exercises correctness at modest scale (1000 rows max in performance-sentinels, 20 tables in schema-scale). Stress tests push the engine harder to surface memory leaks, O(n^2) regressions, stack overflows, and concurrency bugs that only appear under load.

These are NOT benchmarks. They are correctness tests at scale — the assertion is "completes without error and produces correct results", with generous timeouts.

## Design

Create `packages/quereus/test/stress.spec.ts` using Mocha + Chai (consistent with the rest of the test suite). Use `this.timeout(60_000)` for the describe block. Each test creates a fresh Database, inserts data, runs queries, and verifies correctness.

### Test Categories

**Large Dataset Tests**
- Insert 50K rows into a single table, verify count and spot-check values
- GROUP BY on 50K rows with ~500 distinct groups, verify group counts sum to total
- ORDER BY on 50K rows, verify output is sorted
- Full table scan with 20+ columns (wide rows), verify all columns returned

**Deep/Complex Query Tests**
- 5-way join chain (A join B join C join D join E) each with 200 rows, verify result count
- Deeply nested subqueries (8 levels): `select * from t where id in (select id from t where id in (...))`
- CTE recursion to depth 500 (generate_series-style), verify row count
- Compound query: UNION ALL of 10 SELECTs, verify deduplication with UNION

**Concurrent Iterator Tests**
- Open 10 iterators on the same table simultaneously, consume them all, verify each returns full results
- Interleave reads and writes: iterate while inserting into a different table (no cross-table interference)
- Rapid prepare/finalize cycles (100 statements) without leaking

**Schema Scale Tests**
- Create 50 tables, create indexes on each, then run a query that joins 3 of them — verify schema manager handles the load
- Drop and recreate tables in a loop (20 cycles), verify no stale references

### Key Expected Behaviors
- All tests complete within 60s timeout
- Row counts match expectations exactly
- No unhandled promise rejections
- Memory usage stays bounded (no obvious leaks visible as OOM)

## TODO

- Create `packages/quereus/test/stress.spec.ts`
- Implement large dataset tests (50K rows insert, GROUP BY, ORDER BY, wide scan)
- Implement deep query tests (join chain, nested subqueries, recursive CTE, compound)
- Implement concurrent iterator tests (parallel reads, interleaved read/write, prepare/finalize churn)
- Implement schema scale tests (50 tables, drop/recreate cycles)
- Verify all existing tests still pass
- Run the new stress tests and confirm they pass
