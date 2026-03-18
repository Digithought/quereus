description: Systematic review of miscellaneous plan nodes (block, sequencing, set ops, cache, etc.)
dependencies: none
files:
  packages/quereus/src/planner/nodes/block.ts
  packages/quereus/src/planner/nodes/sequencing-node.ts
  packages/quereus/src/planner/nodes/set-operation-node.ts
  packages/quereus/src/planner/nodes/cache-node.ts
  packages/quereus/src/planner/nodes/sink-node.ts
  packages/quereus/src/planner/nodes/remote-query-node.ts
  packages/quereus/src/planner/nodes/table-function-call.ts
  packages/quereus/src/planner/nodes/function.ts
  packages/quereus/src/planner/nodes/view-reference-node.ts
  packages/quereus/src/planner/nodes/pragma.ts
  packages/quereus/src/planner/nodes/analyze-node.ts
  packages/quereus/src/planner/nodes/transaction-node.ts
  packages/quereus/src/planner/nodes/array-index-node.ts
----
Review miscellaneous plan nodes: block/sequencing, set operations (UNION/INTERSECT/EXCEPT), cache, sink, remote query, table-valued functions, view references, pragma, analyze, transactions, and array indexing.

Key areas of concern:
- Set operations — type coercion across branches, duplicate elimination
- UNION ALL vs UNION vs INTERSECT vs EXCEPT correctness
- Cache node — invalidation, memory bounds
- Remote query — serialization, error handling
- Table function — argument binding, output schema
- View reference — expansion correctness, column mapping
- Transaction node — nesting, savepoint semantics
- Block/sequencing — execution order guarantees

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
