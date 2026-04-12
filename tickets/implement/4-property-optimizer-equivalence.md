description: Add differential testing — optimizer rule on vs off produces identical results
dependencies: none
files:
  packages/quereus/test/fuzz.spec.ts
  packages/quereus/src/planner/optimizer-tuning.ts
  packages/quereus/src/planner/framework/registry.ts
  packages/quereus/src/core/database.ts
----
Add property-based differential tests that run the same query with and without specific
optimizer rules and assert identical result sets. This is the highest-value test category for
catching optimizer bugs that produce wrong results silently — a query still succeeds but
returns different data.

**Mechanism**: `OptimizerTuning.disabledRules` (line 52 of optimizer-tuning.ts) accepts a
`ReadonlySet<string>` of rule IDs to skip. Create two Database instances — one default, one
with a rule disabled — seed both with identical data, run the same query, compare results.

**Setup per property run:**
1. Generate a random schema + seed data (reuse `arbSchemaInfo`, `seedTable` from fuzz.spec.ts)
2. Create `dbFull` (all rules enabled) and `dbRestricted` (one rule disabled)
3. Create identical schemas and insert identical data in both
4. Generate random SELECT queries (reuse `buildSqlArbitraries`)
5. Run each query on both databases
6. Compare result sets (order-independent: sort rows by JSON serialization)
7. Any mismatch = optimizer bug

**Rules to test individually:**
- Predicate pushdown rules (predicate/)
- Join selection rules (join/) — bloom join, merge join selection
- Aggregate streaming rule (aggregate/)
- Subquery decorrelation (subquery/)
- CTE materialization (cache/)
- Distinct elimination (distinct/)

First, discover rule IDs by reading the registry.

**Important considerations:**
- Some rule disablements will make queries slower but results must be identical
- Some queries may error with rules disabled (e.g., if a rule is required for correctness) —
  if both error, that's fine; if only one errors, that's a bug
- Use `tryCollectRows` and compare: both-null (both errored) is OK, one-null is a failure,
  both-non-null must have identical row sets
- Keep numRuns low (20-30) since each run creates two databases
- Use small row counts (5-15) to keep execution fast

TODO:
- Read registry.ts to enumerate all rule IDs
- Add new describe block 'Optimizer Equivalence' in fuzz.spec.ts
- Create helper that sets up paired databases with identical schema/data
- Implement differential test for predicate pushdown rules
- Implement differential test for join selection rules
- Implement differential test for aggregate rules
- Implement differential test for subquery decorrelation
- Implement a catch-all test that disables all non-essential rules at once
- Run tests, verify all pass, file fix/ tickets for any failures found
