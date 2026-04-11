description: Review edge-case sqllogic tests for join subsystem
files:
  packages/quereus/test/logic/26-join-edge-cases.sqllogic
----

## Summary

Created `test/logic/26-join-edge-cases.sqllogic` with edge-case tests targeting gaps in join
subsystem coverage. All 542 tests pass (including the new file).

## Test cases added

1. **Complex residual predicates post-join** — equality + inequality ON conditions, expression
   residuals, LEFT JOIN with residuals preserving unmatched rows
2. **Cross joins with filter expressions** — arithmetic WHERE on cross product, full cartesian,
   filter eliminating all rows
3. **Join with all-NULL columns on both sides** — inner join producing zero rows, LEFT JOIN
   with null-padded unmatched, mixed null/non-null keys
4. **Multi-condition join keys with partial NULLs** — two-column ON where partial NULL prevents
   matching, LEFT JOIN padding for unmatched partial-null rows
5. **Self-join with duplicate keys** — combinatorial explosion verification (3×3=9, 2×2=4),
   self-exclusion via `!=`, unique pairs via `<`
6. **Semi/anti join with empty subquery** — correlated EXISTS/NOT EXISTS on empty table,
   uncorrelated EXISTS/NOT EXISTS on empty, IN/NOT IN on empty subquery
7. **Join reordering correctness** — three-way join with different FROM orderings producing
   identical results, predicate filtering across tables, three-way LEFT JOIN
8. **Outer join + aggregate interaction** — count(col) vs count(*) on nullable side, sum/avg/max/min
   returning null for empty groups, coalesce pattern, HAVING filtering on outer-join aggregates

## Validation

- `yarn test` — all 542 tests pass, 0 failures
- New file auto-discovered by the sqllogic test runner via `test/logic.spec.ts`
