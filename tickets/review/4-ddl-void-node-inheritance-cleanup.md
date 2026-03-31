description: Refactored 6 DDL nodes to extend VoidNode class instead of PlanNode + VoidNode interface
dependencies: none
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/nodes/create-assertion-node.ts
  packages/quereus/src/planner/nodes/drop-assertion-node.ts
  packages/quereus/src/planner/nodes/add-constraint-node.ts
  packages/quereus/src/planner/nodes/alter-table-node.ts
  packages/quereus/src/planner/nodes/declarative-schema.ts
----
## What was done

Changed 6 DDL/schema nodes from `extends PlanNode implements VoidNode` to `extends VoidNode`:

- `CreateAssertionNode` — removed getType(), getChildren(), withChildren()
- `DropAssertionNode` — removed getType(), getChildren(), withChildren()
- `AddConstraintNode` — removed getType(), getChildren(), withChildren(); kept getRelations() override (returns table ref)
- `AlterTableNode` — removed getType(), getChildren(), withChildren(); kept getRelations() override (returns table ref)
- `DeclareSchemaNode` — removed getType(), getChildren(), withChildren()
- `ApplySchemaNode` — removed getType(), getChildren(), withChildren()

Each node now inherits the shared implementations from the `VoidNode` abstract class (plan-node.ts:233-253), matching the pattern used by other DDL nodes (CreateTableNode, DropTableNode, etc.).

Import cleanup: removed unused `PlanNode` imports where no longer needed, removed `VoidType` type imports, changed `type VoidNode` to value import `VoidNode`.

## Testing notes

- Build passes (full monorepo)
- All 1013 quereus tests pass
- No new lint errors
- Key use cases to verify: CREATE/DROP ASSERTION, ADD CONSTRAINT, ALTER TABLE (rename/add/drop column), DECLARE SCHEMA, APPLY SCHEMA
- The getRelations() overrides on AddConstraintNode and AlterTableNode ensure table references are still reported correctly for optimizer/analysis passes
