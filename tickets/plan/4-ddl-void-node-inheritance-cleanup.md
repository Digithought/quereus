description: Refactor DDL nodes to extend VoidNode class instead of PlanNode + VoidNode interface
dependencies: none
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/nodes/create-assertion-node.ts
  packages/quereus/src/planner/nodes/drop-assertion-node.ts
  packages/quereus/src/planner/nodes/add-constraint-node.ts
  packages/quereus/src/planner/nodes/alter-table-node.ts
  packages/quereus/src/planner/nodes/declarative-schema.ts
----
## Problem

Six DDL/schema nodes extend `PlanNode` and implement `VoidNode` as an interface, duplicating the boilerplate that the `VoidNode` abstract class already provides (`getType()`, `getChildren()`, `withChildren()`):

- `CreateAssertionNode`
- `DropAssertionNode`
- `AddConstraintNode`
- `AlterTableNode`
- `DeclareSchemaNode`
- `ApplySchemaNode`

Meanwhile, other DDL nodes (`CreateTableNode`, `CreateViewNode`, `CreateIndexNode`, `DropTableNode`, `DropViewNode`) correctly extend the `VoidNode` class and inherit the shared implementation.

## Proposed Change

Change the six nodes above to `extends VoidNode` instead of `extends PlanNode implements VoidNode`. Remove their duplicated `getType()`, `getChildren()`, and `withChildren()` overrides.

Nodes that override `getRelations()` to return their table reference (e.g., `AddConstraintNode`, `AlterTableNode`) will retain that override since `VoidNode.getRelations()` returns `[]`.

## Notes

- `DropTableNode.getLogicalAttributes()` also has an `eslint-disable` + `as any` cast for `expressionToString(this.statementAst as any)`. Consider addressing that during this refactoring if a proper overload/type exists.
- `ConstraintCheckNode.toString()` and `getLogicalAttributes()` use magic numbers (1, 2, 4) for `RowOpFlag` instead of the enum — this is blocked by `const enum` + `import type` semantics but could be addressed with a helper function or regular import.
