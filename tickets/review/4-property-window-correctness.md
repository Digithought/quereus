description: Review property-based tests for window function correctness invariants
dependencies: none
files:
  packages/quereus/test/property.spec.ts
----
Added 5 property-based tests in the "Window Function Invariants" describe block (section 13)
in property.spec.ts. Each test uses fast-check to generate random data and verify mathematical
invariants of window function outputs.

**Tests added:**

1. **row_number() contiguous 1..N (unpartitioned)** — inserts N random rows, verifies
   `row_number() over (order by id)` produces exactly [1, 2, ..., N].

2. **Partitioned row_number() 1..K per partition** — generates rows with random group keys (1-3),
   verifies row_number restarts at 1 and is contiguous within each partition.

3. **Running sum = cumulative sum** — verifies
   `sum(val) over (order by id rows between unbounded preceding and current row)` matches
   independently-computed cumulative sums. Uses integer columns to avoid FP drift.

4. **Total window sum = aggregate sum** — verifies `sum(val) over ()` on every row equals
   `select sum(val) from t`.

5. **rank()/dense_rank() tie consistency** — generates rows with small-range sort keys to
   ensure ties. Verifies: same sort_key → same rank; dense_rank has no gaps (1, 2, 3, ...);
   rank matches 1-based position of first occurrence in sorted order.

**Testing notes:**
- All 5 tests pass (50 runs each)
- Full property.spec.ts suite passes (41 tests)
- Type check clean
- Uses integer-only data for sum properties to avoid floating-point issues
- Uses parameterized queries with prepared statements
