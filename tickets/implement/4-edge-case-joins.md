description: Add edge-case sqllogic tests for join subsystem
dependencies: none (complements 4-coverage-runtime-emitters which targets emitter branch coverage)
files:
  packages/quereus/test/logic/11-joins.sqllogic
  packages/quereus/test/logic/12-join_padding_order.sqllogic
  packages/quereus/test/logic/23-self-joins-duplicates.sqllogic
  packages/quereus/test/logic/82-bloom-join.sqllogic
  packages/quereus/test/logic/83-merge-join.sqllogic
  packages/quereus/test/logic/08.1-semi-anti-join.sqllogic
  packages/quereus/src/runtime/emit/merge-join.ts
  packages/quereus/src/runtime/emit/bloom-join.ts
  packages/quereus/src/runtime/emit/nested-loop-join.ts
----
Focused sqllogic tests targeting join edge cases. The existing test files provide good baseline
coverage of empty tables, NULL keys, self-joins, many-to-many, and outer join padding. This
ticket fills remaining gaps in join semantics.

**Gaps to cover:**

- **Complex residual predicates post-join**: joins with ON conditions that combine equality and
  inequality predicates — verify residual filtering after the join operator doesn't drop rows
  or produce wrong matches
- **Cross joins with expressions**: `select * from a cross join b where a.x + b.y > 10` —
  verify filter interacts correctly with cross product
- **Join with all-NULL columns on both sides**: both tables have a NULL-only join column —
  inner join should produce zero rows; left/right should produce unmatched rows with padding
- **Multi-condition join keys**: `ON a.x = b.x AND a.y = b.y` with NULLs in some key columns
  — partial NULL match should not equate
- **Self-join edge cases**: self-join where the join key has duplicates, producing combinatorial
  explosion — verify row count is correct (n*m for m matching rows per group)
- **Semi/anti join with empty subquery**: `WHERE EXISTS (select 1 from empty)` should eliminate
  all rows; `WHERE NOT EXISTS (select 1 from empty)` should keep all rows
- **Join reordering correctness**: three-way join where reordering would change semantics if
  predicates are misattributed — verify result is identical regardless of table order in FROM
- **Outer join + aggregate interaction**: LEFT JOIN with aggregate on the nullable side —
  `count(right.col)` should not count NULL-padded rows, but `count(*)` should

Target test file: `test/logic/26-join-edge-cases.sqllogic`

TODO:
- Create `test/logic/26-join-edge-cases.sqllogic`
- Cover each gap bullet above with at least one test case
- Run tests and verify all pass (or document any bugs found as new fix/ tickets)
