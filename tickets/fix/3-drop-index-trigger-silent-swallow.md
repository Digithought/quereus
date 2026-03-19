description: DROP INDEX and DROP TRIGGER statements silently ignored in block planner
dependencies: none
files:
  packages/quereus/src/planner/building/block.ts
  packages/quereus/src/planner/nodes/drop-table-node.ts
  packages/quereus/src/planner/nodes/plan-node-type.ts (DropIndex already exists)
  packages/quereus/src/runtime/emit/drop-table.ts
  packages/quereus/src/schema/schema-differ.ts (generates DROP INDEX IF EXISTS)
  packages/quereus/src/vtab/table.ts (dropIndex interface)
  packages/quereus/src/vtab/memory/table.ts (dropIndex implementation)
----
## Problem

In `block.ts:39-47`, the `drop` case handles 'table', 'view', and 'assertion' but falls through with `break` for 'index' and 'trigger' (`AST.DropStmt.objectType` is `'table' | 'view' | 'index' | 'trigger' | 'assertion'`). The `undefined` from the break is silently filtered out at line 89.

This means `DROP INDEX` and `DROP TRIGGER` statements are silently ignored.

**Impact:** The declarative schema system (`schema-differ.ts:262`) generates `DROP INDEX IF EXISTS` as part of `APPLY SCHEMA` migrations. These are currently silently swallowed, meaning index cleanup during schema migrations is not actually happening. The migration appears to succeed because subsequent table operations may handle this implicitly, but orphaned indexes could accumulate.

## Required Changes

### DROP INDEX (priority)
- `PlanNodeType.DropIndex` already exists in plan-node-type.ts
- `VirtualTable.dropIndex()` interface already exists in vtab/table.ts
- Memory table implementation exists in vtab/memory/table.ts

Implementation:
- Create `DropIndexNode` plan node (or reuse DropTableNode for both)
- Create `emitDropIndex` emitter (needs to resolve index → table, then call vtab.dropIndex)
- May need a `SchemaManager.findIndexOwner(indexName)` to locate which table owns the index
- Route 'index' in block.ts drop case to the new builder
- Wire emitter in the emission dispatch

### DROP TRIGGER
- Lower priority; trigger support may be incomplete elsewhere
- At minimum, the block.ts should throw `UNSUPPORTED` instead of silently succeeding

## TODO

- Phase 1: Implement DROP INDEX support (node, emitter, block routing)
- Phase 2: Add `SchemaManager.findIndexOwner()` or similar lookup
- Phase 3: Throw UNSUPPORTED for DROP TRIGGER instead of silent swallow
- Phase 4: Add sqllogic tests for standalone `DROP INDEX` and `DROP INDEX IF EXISTS`
