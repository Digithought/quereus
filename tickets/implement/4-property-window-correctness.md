description: Add property-based tests for window function correctness invariants
dependencies: none
files:
  packages/quereus/test/property.spec.ts
  packages/quereus/test/fuzz.spec.ts
----
Add property-based tests that verify window function output satisfies mathematical invariants.
The existing fuzz.spec.ts tests window functions for no-crash behavior but never checks the
values returned are correct. These properties catch subtle off-by-one and frame-boundary bugs.

**Properties to add:**

- **row_number() produces contiguous 1..N**: for any table with N rows,
  `select row_number() over (order by col) as rn from t` must produce exactly the values
  {1, 2, ..., N} with no gaps or duplicates.

- **Partitioned row_number() produces 1..K per partition**: for each partition group,
  row_number restarts at 1 and is contiguous within the partition.

- **Running sum via window = cumulative sum**: for a numeric column,
  `sum(x) over (order by id rows between unbounded preceding and current row)` at each row
  must equal the sum of all x values from the first row through the current row (computed
  independently via iteration). Use integer columns to avoid floating-point drift.

- **Total window sum = aggregate sum**: `sum(x) over ()` (unpartitioned, no order) on every
  row must equal `select sum(x) from t`.

- **rank() ties**: when two rows have the same order key, `rank()` must return the same value
  for both. `dense_rank()` must have no gaps. Verify by checking: for each distinct rank value,
  all rows with that rank have the same order key value.

Use the existing `arbSchemaInfo` + `seedTable` infrastructure from fuzz.spec.ts. Filter to
tables that have at least one integer/real column for the sum properties. Keep numRuns at
50-100.

TODO:
- Add new describe block 'Window Function Invariants' in property.spec.ts or fuzz.spec.ts
- Implement row_number contiguity property (unpartitioned)
- Implement partitioned row_number property
- Implement running sum = cumulative sum property
- Implement total window sum = aggregate sum property
- Implement rank/dense_rank tie consistency property
- Run tests, verify all pass, file fix/ tickets for any failures found
