description: Systematic review of aggregate and window plan nodes
dependencies: none
files:
  packages/quereus/src/planner/nodes/aggregate-node.ts
  packages/quereus/src/planner/nodes/hash-aggregate.ts
  packages/quereus/src/planner/nodes/stream-aggregate.ts
  packages/quereus/src/planner/nodes/aggregate-function.ts
  packages/quereus/src/planner/nodes/window-node.ts
  packages/quereus/src/planner/nodes/window-function.ts
----
Review aggregate and window plan nodes: logical aggregate, hash aggregate, stream aggregate, aggregate function descriptors, window node, and window function descriptors.

Key areas of concern:
- Group-by key correctness and null grouping
- Hash vs stream aggregate selection criteria
- Aggregate function state lifecycle (init, step, finalize)
- DISTINCT aggregates handling
- Window frame specification (ROWS, RANGE, GROUPS)
- Window frame boundary correctness (UNBOUNDED, CURRENT ROW, N PRECEDING/FOLLOWING)
- Partition-by / order-by interaction
- Multiple window functions sharing a window definition

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
