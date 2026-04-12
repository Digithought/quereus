description: SELECT DISTINCT returns duplicate rows across all column types
dependencies: none
files:
  packages/quereus/test/fuzz.spec.ts
  packages/quereus/src/planner/rules/distinct/
  packages/quereus/src/runtime/emit/
----
## Bug

`SELECT DISTINCT col FROM table` returns duplicate values. Verified by property-based
testing across integer, text, real, blob, and any column types — all exhibit the issue.

## Reproduction

In `packages/quereus/test/fuzz.spec.ts`, the `Algebraic Identities` describe block contains
a skipped test `SELECT DISTINCT results are unique`. Remove the `.skip` to reproduce.

Counterexample from fuzzing: a table `t1` with a `text` column having `unique` constraint.
After seeding 10 rows, `select distinct c_text2 from t1` returned 8 rows but only 7 unique
values when serialized to JSON. The unique constraint should guarantee all stored values are
distinct, yet DISTINCT still produces duplicate output rows.

## Analysis Hints

- The issue is systemic across all column types (integer, real, text, blob, any)
- Likely a comparison/hashing issue in the DISTINCT planner node or emitter
- Check how the DistinctNode compares rows — may be using reference equality for
  non-primitive types, or the hash/sort used for deduplication may not be stable
- The sort-based or hash-based distinct implementation may not properly handle all
  SQL value types

## Expected Behavior

`SELECT DISTINCT col FROM t` must never return two rows where the values compare as equal.
The row count of DISTINCT should equal the set size when values are serialized.
