description: Stress tests for large datasets, deep queries, and concurrent access patterns
files:
  - packages/quereus/test/stress.spec.ts
----

## What Was Built

Created `packages/quereus/test/stress.spec.ts` with 14 stress tests across 4 categories, all passing within a 60-second timeout (~30s actual).

### Categories (14 tests total)
- **Large dataset (4)**: 50K row insert/count, GROUP BY on 50K rows, ORDER BY sort verification, wide row scan (25 columns)
- **Deep/complex queries (5)**: 5-way join chain, nested subqueries (5 levels), recursive CTE depth 500, UNION ALL of 10 SELECTs, UNION deduplication
- **Concurrent iterators (3)**: 10 sequential iterators, interleaved reads/writes, 100 prepare/finalize cycles
- **Schema scale (2)**: 50 tables with indexes + join, drop/recreate 20 cycles

## Key Design Decisions
- Nested subquery depth is 5 (not 8) due to exponential planner cost growth — useful signal for future optimizer work
- Tests assert correctness at scale, not performance benchmarks

## Testing
- All 14 tests pass (~30s total)
- The pre-existing `08.1-semi-anti-join.sqllogic` failure is unrelated (planner bug)

## Review Notes
- Clean structure: 4 describe blocks with proper beforeEach/afterEach cleanup
- `collect` helper duplicated across test files (pre-existing pattern, not introduced here)
- Assertions verify meaningful properties (counts, sort order, group sizes, column completeness)
