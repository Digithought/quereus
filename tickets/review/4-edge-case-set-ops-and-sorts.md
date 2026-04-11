description: Edge-case sqllogic tests for set operations and ORDER BY
dependencies: none
files:
  packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/src/runtime/emit/sort.ts
  packages/quereus/src/planner/building/select-compound.ts
  packages/quereus/src/planner/nodes/set-operation-node.ts
----

Created `test/logic/28-set-ops-sort-edge-cases.sqllogic` covering edge cases for set operations
and ORDER BY that weren't previously tested.

**Set operation tests added:**
- Empty inputs (empty left, empty right, both empty) for UNION, UNION ALL, INTERSECT, EXCEPT, DIFF
- All-duplicate inputs for UNION (dedup to one), UNION ALL (keep all), INTERSECT, EXCEPT
- Three-way set operations documenting right-associative evaluation (parser chains A op1 B op2 C as A op1 (B op2 C))
- CTE workaround to force left-to-right evaluation
- Column count mismatch errors for UNION and INTERSECT
- ORDER BY on combined set operation result (ASC and DESC)
- Type preservation: left-side types kept for matching values, right-side types for new values
- EXCEPT with disjoint sets (returns all of A)
- DIFF identity properties: A DIFF A = empty, A DIFF empty = A, empty DIFF A = A

**Sort tests added:**
- Sort stability with duplicate keys (insertion order preserved)
- Expression-based ORDER BY with NULLs: coalesce(x, 0), x IS NULL
- ORDER BY on aliased expressions: x+10 AS y ORDER BY y, coalesce alias
- 5-column ORDER BY mixing ASC/DESC and NULLS FIRST
- ORDER BY in subquery vs outer: outer ordering wins

**Behavioral notes documented in tests:**
- Compound set operations are right-associative (not left-to-right like SQL standard)
- INTEGER columns are NOT NULL by default; use `INTEGER NULL` for nullable
- JS normalizes `3.0` to `3` (integer), so `typeof(3.0)` reports 'integer'

**Validation:**
- All 1696 tests pass (including 28 new test cases in the file)
- Typecheck clean
- No bugs found; all edge cases behave correctly
