description: Systematic review of planner building for SELECT statements
dependencies: none
files:
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-context.ts
  packages/quereus/src/planner/building/select-projections.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-window.ts
  packages/quereus/src/planner/building/select-compound.ts
----
Review the SELECT statement plan builder: main select orchestration, context management, projection building, modifiers (ORDER BY, LIMIT, DISTINCT), aggregate detection and grouping, window function handling, and compound selects (UNION, INTERSECT, EXCEPT).

Key areas of concern:
- Column resolution and ambiguity detection
- Star expansion correctness (qualified vs unqualified)
- GROUP BY validation (non-aggregated columns)
- HAVING clause — aggregate vs non-aggregate expression validation
- ORDER BY — ordinal references, alias references, expression references
- Window function — PARTITION BY / ORDER BY resolution
- Compound select — column count matching, type coercion
- Subquery in SELECT list — correlation handling

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
