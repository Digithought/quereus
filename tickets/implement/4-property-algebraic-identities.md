description: Add property-based tests for relational algebraic identities
dependencies: none
files:
  packages/quereus/test/property.spec.ts
  packages/quereus/test/fuzz.spec.ts
----
Extend the property-based test suite with tests that verify relational algebraic identities
hold across randomly generated schemas and data. These catch semantic bugs that no-crash fuzzing
misses — a query returning wrong results won't crash but will violate an algebraic law.

The fuzz.spec.ts already has schema/data generators (`arbSchemaInfo`, `seedTable`,
`buildSqlArbitraries`) and helpers (`collectRows`, `tryCollectRows`). Reuse those.

**Properties to add (in fuzz.spec.ts, new describe block):**

- **count(*) matches iteration**: for each table, `select count(*) from t` must equal the
  number of rows yielded by `select * from t`. The existing test only checks non-negative.

- **SELECT DISTINCT results are unique**: `select distinct col from t` must not contain
  duplicate values. Serialize each row to JSON and check the set size equals the array length.

- **UNION deduplicates, UNION ALL does not**:
  - `(A union A)` row count <= `A` row count
  - `(A union all A)` row count = 2 * `A` row count
  - `(A union B)` row count <= `(A union all B)` row count

- **EXCEPT + INTERSECT = original**:
  `(A except B) union (A intersect B)` must equal `A` (as sets — compare sorted, deduplicated).
  Use single-column projections to keep comparison tractable.

- **DIFF empty iff identical**:
  `A diff A` must return zero rows.
  For tables with identical content: `not exists (A diff B)` iff sorted A = sorted B.

- **Aggregate consistency**: `select sum(col) from t` must equal the sum of all individual
  `col` values collected via `select col from t` (with NULL handling: NULLs excluded from sum,
  all-NULL returns NULL).

Each property should use `fc.asyncProperty` with `arbSchemaInfo` and a row count parameter.
Use `tryCollectRows` and skip (via `fc.pre(false)`) if queries error due to type mismatches.
Keep numRuns at 50-100 to stay under CI time limits.

TODO:
- Add new describe block 'Algebraic Identities' in fuzz.spec.ts (or property.spec.ts)
- Implement count(*)-matches-iteration property
- Implement DISTINCT-uniqueness property
- Implement UNION/UNION ALL relationship properties
- Implement EXCEPT+INTERSECT=original property
- Implement DIFF-empty-iff-identical property
- Implement sum-consistency property
- Run tests, verify all pass, file fix/ tickets for any failures found
