description: Systematic review of query plan nodes (reference, filter, project, sort, etc.)
dependencies: none
files:
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/planner/nodes/table-access-nodes.ts
  packages/quereus/src/planner/nodes/filter.ts
  packages/quereus/src/planner/nodes/project-node.ts
  packages/quereus/src/planner/nodes/alias-node.ts
  packages/quereus/src/planner/nodes/sort.ts
  packages/quereus/src/planner/nodes/limit-offset.ts
  packages/quereus/src/planner/nodes/distinct-node.ts
  packages/quereus/src/planner/nodes/single-row.ts
  packages/quereus/src/planner/nodes/values-node.ts
  packages/quereus/src/planner/nodes/retrieve-node.ts
----
Review core query plan nodes: table reference/access, filter, projection, alias, sort, limit/offset, distinct, single-row, values, and retrieve.

Key areas of concern:
- Reference node — column binding correctness, output descriptor
- Table access — index selection interface, filter pushdown
- Filter — predicate representation and simplification
- Project — expression list correctness, star expansion
- Sort — collation handling, null ordering, stability
- Limit/offset — boundary conditions (0, negative, null)
- Distinct — equality semantics, null handling
- Values — type inference across rows, column count validation

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
