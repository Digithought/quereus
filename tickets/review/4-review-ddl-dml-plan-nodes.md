description: Systematic review of DDL and DML plan nodes
dependencies: none
files:
  packages/quereus/src/planner/nodes/insert-node.ts
  packages/quereus/src/planner/nodes/update-node.ts
  packages/quereus/src/planner/nodes/delete-node.ts
  packages/quereus/src/planner/nodes/dml-executor-node.ts
  packages/quereus/src/planner/nodes/returning-node.ts
  packages/quereus/src/planner/nodes/constraint-check-node.ts
  packages/quereus/src/planner/nodes/add-constraint-node.ts
  packages/quereus/src/planner/nodes/create-table-node.ts
  packages/quereus/src/planner/nodes/create-view-node.ts
  packages/quereus/src/planner/nodes/create-index-node.ts
  packages/quereus/src/planner/nodes/create-assertion-node.ts
  packages/quereus/src/planner/nodes/drop-table-node.ts
  packages/quereus/src/planner/nodes/drop-view-node.ts
  packages/quereus/src/planner/nodes/drop-assertion-node.ts
  packages/quereus/src/planner/nodes/alter-table-node.ts
  packages/quereus/src/planner/nodes/declarative-schema.ts
----
Review DDL and DML plan nodes: INSERT, UPDATE, DELETE, DML executor, RETURNING, constraint checks, and all CREATE/DROP/ALTER nodes.

Key areas of concern:
- INSERT — column mapping, DEFAULT handling, ON CONFLICT
- UPDATE — SET expression binding, WHERE filter correctness
- DELETE — cascade/restrict semantics
- DML executor — transaction boundary, error rollback
- RETURNING — output column binding post-mutation
- Constraint check — CHECK, NOT NULL, UNIQUE, FK validation ordering
- DDL nodes — IF EXISTS/IF NOT EXISTS handling
- Declarative schema — diff-based migration correctness
- ALTER TABLE — column add/drop/rename, type change safety

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
