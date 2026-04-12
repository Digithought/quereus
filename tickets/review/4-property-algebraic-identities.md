description: Review property-based tests for relational algebraic identities
dependencies: none
files:
  packages/quereus/test/fuzz.spec.ts (lines 820-1107, "Phase 4: Algebraic Identity Properties")
----
Six algebraic identity properties were added as a new `describe('Algebraic Identities')` block
in fuzz.spec.ts, reusing the existing schema/data generators and helpers.

**Properties implemented:**

- **COUNT(*) matches iteration**: `select count(*) from t` equals row count from `select * from t`.
- **SELECT DISTINCT results are unique**: Verifies no duplicate rows in DISTINCT output.
  Currently `.skip`'d — filed as separate fix ticket `4-distinct-deduplication-bug.md`.
- **UNION deduplicates, UNION ALL does not**: Three sub-checks: `UNION ALL A,A` = 2×base,
  `UNION A,A` ≤ base, `UNION` ≤ `UNION ALL` across tables.
- **EXCEPT + INTERSECT = original (as sets)**: `(A except B) union (A intersect B)` equals
  deduplicated A. Uses cast-to-text single-column projection for tractable comparison.
- **A EXCEPT A returns zero rows**: Self-difference yields empty result.
- **SUM consistency**: `select sum(col)` matches manual summation of individual values,
  with NULL handling (all-NULL → NULL).

**Test results:** 5 passing, 1 pending (DISTINCT skip). numRuns 75-100 per property.

**Review checklist:**
- Verify test coverage is sufficient for each algebraic law
- Ensure numRuns are appropriate for CI time limits
- Check that DISTINCT skip is justified and tracked
- Confirm no regressions in other fuzz/property tests
