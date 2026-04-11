description: Add edge-case sqllogic tests for set operations and ORDER BY
dependencies: none
files:
  packages/quereus/test/logic/09-set_operations.sqllogic
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/src/runtime/emit/sort.ts
----
Focused sqllogic tests targeting set operation and sort edge cases. The existing set_operations
tests cover basic UNION/INTERSECT/EXCEPT/DIFF semantics, type coercion, and NULL handling. Sort
tests across the suite cover ASC/DESC, NULLS FIRST/LAST, and multi-column sorts. This ticket
fills the remaining gaps.

**Set operation gaps to cover:**

- **Empty inputs**: `(select * from t where 1=0) union (select * from t)` and reverse — empty
  left, empty right, both empty for UNION, INTERSECT, EXCEPT, DIFF
- **All-duplicate inputs**: table with all identical rows fed to UNION (should deduplicate to
  one), UNION ALL (should keep all), INTERSECT, EXCEPT
- **Three-way set operations**: `A UNION B EXCEPT C` — verify left-to-right evaluation and
  precedence
- **Column count mismatch (error)**: `select 1 union select 1, 2` — should produce a clear
  error
- **Set operations with ORDER BY**: `select ... union select ... order by 1` — verify ordering
  applies to the combined result, not just the last branch
- **Set operations preserving type**: verify that `select 1 union select 1.0` returns the
  appropriate type (integer or real — document the actual behavior)
- **EXCEPT with no overlap**: A EXCEPT B where A and B are disjoint — should return all of A
- **DIFF identity**: `A DIFF A` should always be empty; `A DIFF empty` should equal A

**Sort gaps to cover:**

- **Sort stability with fully duplicate keys**: insert rows with identical sort keys in known
  order, verify output preserves insertion order (or document if unstable)
- **Expression-based ORDER BY with NULLs**: `ORDER BY coalesce(x, 0)` where some rows have
  NULL x — verify the expression result governs ordering
- **ORDER BY on aliased expressions**: `select x+1 as y from t order by y` — verify alias
  resolution
- **ORDER BY ordinal out of range (error)**: `select a, b from t order by 3` — should error
- **Large multi-column sort**: ORDER BY with 5+ columns mixing ASC/DESC and NULLS FIRST/LAST
  — verify composite ordering is correct
- **ORDER BY in subquery vs outer**: `select * from (select * from t order by x) order by y`
  — verify outer ordering wins

Target test file: `test/logic/28-set-ops-sort-edge-cases.sqllogic`

TODO:
- Create `test/logic/28-set-ops-sort-edge-cases.sqllogic`
- Cover each gap bullet above with at least one test case
- Run tests and verify all pass (or document any bugs found as new fix/ tickets)
