description: Property-based tests for relational algebraic identities
dependencies: none
files:
  packages/quereus/test/fuzz.spec.ts
  tickets/fix/4-distinct-deduplication-bug.md
----
## Summary

Added a new `Algebraic Identities` describe block in `fuzz.spec.ts` with property-based tests
that verify relational algebraic laws hold across randomly generated schemas and data.

## Properties implemented

1. **COUNT(*) matches iteration** — `select count(*) from t` equals the number of rows from
   `select * from t`. 100 runs.

2. **SELECT DISTINCT results are unique** — currently `.skip`ped because it uncovered a
   systemic DISTINCT deduplication bug affecting all column types. Fix ticket filed at
   `tickets/fix/4-distinct-deduplication-bug.md`.

3. **UNION deduplicates, UNION ALL does not** — verifies:
   - `A union all A` row count = 2 * `A` row count
   - `A union A` row count <= `A` row count
   - Cross-table: `A union B` row count <= `A union all B` row count
   75 runs.

4. **EXCEPT + INTERSECT = original (as sets)** — `(A except B) union (A intersect B)` equals
   the distinct values of A. Uses cast-to-text for cross-table type compatibility. Uses a
   dedicated multi-table schema generator (min 2 tables) to avoid excessive pre-condition
   skips. 75 runs.

5. **A EXCEPT A returns zero rows** — self-except yields empty result for every table/column
   combination. 100 runs.

6. **SUM consistency** — `select sum(col) from t` matches the manual sum of individual values
   collected via `select col from t`, with NULL handling (NULLs excluded, all-NULL returns
   NULL). Tests only integer and real columns. Uses 1e-6 tolerance for floating-point. 100 runs.

## Bug found

DISTINCT deduplication is broken across all column types. Filed as
`tickets/fix/4-distinct-deduplication-bug.md`. The DISTINCT uniqueness property test is
skipped until the underlying bug is fixed.

## Test commands

```bash
# Run just the algebraic identity tests
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js --grep "Algebraic Identities" "packages/quereus/test/fuzz.spec.ts" --timeout 180000

# Run all fuzz tests
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/fuzz.spec.ts" --timeout 180000
```

## Review checklist
- [ ] Verify algebraic identity tests cover the specified properties
- [ ] Verify test isolation (each property creates/closes its own Database)
- [ ] Verify numRuns are reasonable for CI (50-100 range)
- [ ] Verify the DISTINCT bug report is accurate and actionable
- [ ] Ensure no regressions in existing fuzz tests
