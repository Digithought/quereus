description: Systematic review of all optimizer rules
dependencies: none
files:
  packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts
  packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts
  packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts
  packages/quereus/src/planner/rules/cache/rule-materialization-advisory.ts
  packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts
  packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts
  packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts
  packages/quereus/src/planner/rules/join/rule-join-key-inference.ts
  packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts
  packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts
  packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts
  packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
----
Review all optimizer rules: access path selection, aggregate streaming, CTE optimization, subquery/CSE caching, distinct elimination, join ordering/commutation/physical selection, predicate pushdown/merge, projection pruning, retrieve growth, and subquery decorrelation.

Key areas of concern:
- Rule applicability guards (pattern matching correctness)
- Semantic preservation (rule doesn't change query results)
- Predicate pushdown — safe vs unsafe pushdown (through outer joins, aggregates)
- Join commutation — preserving outer join semantics
- Subquery decorrelation — correlation variable rebinding
- Access path selection — correct cost comparison
- CTE optimization — when to materialize vs inline
- Projection pruning — not dropping needed columns
- Filter merge — AND/OR logic correctness
- Distinct elimination — sound reasoning about uniqueness

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
