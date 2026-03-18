description: Systematic review of plan node base classes and scalar expressions
dependencies: none
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/nodes/plan-node-type.ts
  packages/quereus/src/planner/nodes/scalar.ts
----
Review the plan node base infrastructure: PlanNode base class, node type enum, and scalar expression nodes.

Key areas of concern:
- PlanNode base class — clone, equality, child traversal correctness
- Node type enum completeness (all node types registered)
- Scalar expression — operator handling, type inference, null propagation
- Deep cloning correctness (shared references, circular refs)
- Output column descriptor computation

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
