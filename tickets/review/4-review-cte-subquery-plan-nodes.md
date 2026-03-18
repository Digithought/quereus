description: Systematic review of CTE and subquery plan nodes
dependencies: none
files:
  packages/quereus/src/planner/nodes/cte-node.ts
  packages/quereus/src/planner/nodes/cte-reference-node.ts
  packages/quereus/src/planner/nodes/recursive-cte-node.ts
  packages/quereus/src/planner/nodes/internal-recursive-cte-ref-node.ts
  packages/quereus/src/planner/nodes/subquery.ts
----
Review CTE and subquery plan nodes: CTE definition, CTE reference, recursive CTE, and subquery expressions (scalar, EXISTS, IN).

Key areas of concern:
- CTE materialization vs inline expansion decision
- CTE reference — correct binding to definition, column mapping
- Recursive CTE — termination detection, working table lifecycle
- Recursive CTE — UNION vs UNION ALL semantics
- Subquery correlation — outer reference binding
- Scalar subquery — multiple-row error handling
- EXISTS subquery — short-circuit semantics
- IN subquery — null handling (three-valued logic)

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
