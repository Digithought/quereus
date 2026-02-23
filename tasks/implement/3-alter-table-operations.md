---
description: Implement remaining ALTER TABLE operations (RENAME TABLE, RENAME COLUMN, ADD COLUMN, DROP COLUMN)
dependencies: Schema system (table.ts, manager.ts), DDL planner (alter-table.ts), vtab module interface, MemoryTable module

---

## Overview

The parser handles all five ALTER TABLE action types. Only `ADD CONSTRAINT` (for CHECK) is implemented. The remaining four — `renameTable`, `renameColumn`, `addColumn`, `dropColumn` — throw UNSUPPORTED in `src/planner/building/alter-table.ts`. This task implements them.

## Key Files

- `src/planner/building/alter-table.ts` — `buildAlterTableStmt()` — currently only handles `addConstraint`
- `src/planner/nodes/add-constraint-node.ts` — existing plan node (model for new nodes)
- `src/runtime/emit/add-constraint.ts` — existing emitter (model for new emitters)
- `src/schema/table.ts` — `TableSchema`, `buildColumnIndexMap()`, `findPKDefinition()`
- `src/schema/column.ts` — `ColumnSchema`, `columnDefToSchema()`
- `src/schema/manager.ts` — `SchemaManager` (table lookup, registration)
- `src/schema/schema.ts` — `Schema` class (addTable, removeTable)
- `src/schema/view.ts` — `ViewSchema` (views may reference renamed tables/columns)
- `src/vtab/module.ts` — `VirtualTableModule` interface (needs ALTER support)
- `src/vtab/memory/module.ts` / `table.ts` — MemoryTable implementation
- `src/parser/ast.ts` — `AlterTableAction` type union (~line 467)
- `src/schema/schema-differ.ts` — declarative schema diffing
- `test/logic/40-constraints.sqllogic` — existing constraint/DDL tests

## Architecture

### Plan Nodes

Create new plan nodes for each ALTER action (or a single `AlterTableNode` with a discriminated action field). Each extends `VoidNode`:

- `RenameTableNode` — stores table reference + new name
- `RenameColumnNode` — stores table reference + old name + new name
- `AddColumnNode` — stores table reference + column definition
- `DropColumnNode` — stores table reference + column name

### VTab Module Interface Extension

Add an optional `alterTable` method to `VirtualTableModule`:

```typescript
interface VirtualTableModule<TTable, TConfig> {
  // ... existing methods ...

  /**
   * Alter an existing table's structure. Called by ALTER TABLE.
   * If not implemented, the engine handles schema-only changes
   * and rejects data-affecting changes.
   */
  alterTable?(
    db: Database,
    table: TTable,
    action: AlterTableModuleAction,
  ): Promise<void>;
}

type AlterTableModuleAction =
  | { type: 'addColumn', column: ColumnSchema, defaultValue: SqlValue | null }
  | { type: 'dropColumn', columnIndex: number }
  // renameTable and renameColumn are schema-only, no module call needed
```

The module is responsible for any data-level changes (e.g., extending existing rows for ADD COLUMN).

### Operation Details

**RENAME TABLE:**
- Schema-only operation. Remove old entry from `Schema.tables`, add under new name.
- Update `tableSchema.name` on the (immutable, so clone) schema.
- Cascade: update any views that reference the old table name (or error if views depend on it).
- Notify schema change.

**RENAME COLUMN:**
- Schema-only operation. Clone `TableSchema`, update the column's `name` field.
- Rebuild `columnIndexMap`.
- Update primary key definitions if the renamed column is in the PK.
- Update CHECK constraint expressions if they reference the column by name (AST rewriting or simply re-parse — but since constraints store parsed `Expression` ASTs with column references, renaming is complex; consider erroring if the column is referenced by constraints, or storing column references by index).
- Cascade: update views/indexes that reference the old column name (or error).
- Notify schema change.

**ADD COLUMN:**
- Create `ColumnSchema` from the AST `ColumnDef` using `columnDefToSchema()`.
- Validate: cannot add NOT NULL column without DEFAULT unless table is empty.
- Cannot add a PRIMARY KEY column (PK is immutable after creation).
- Clone `TableSchema`, append column, rebuild `columnIndexMap`.
- Call `module.alterTable({ type: 'addColumn', column, defaultValue })` to backfill existing rows.
- For MemoryTable: iterate all rows, append the default value to each.
- Notify schema change.

**DROP COLUMN:**
- Validate: cannot drop PK column, cannot drop last column, cannot drop if column is in a CHECK constraint or index.
- Clone `TableSchema`, remove column, rebuild `columnIndexMap`, adjust indices in PK definition and indexes.
- Call `module.alterTable({ type: 'dropColumn', columnIndex })` to strip column from existing rows.
- For MemoryTable: iterate all rows, remove the column at the given index.
- Remove any indexes that reference the dropped column.
- Notify schema change.

### MemoryTable Implementation

`MemoryTable` stores rows as arrays (tuples) in a `digitree` keyed by PK. For ADD COLUMN, iterate all entries and extend the array. For DROP COLUMN, iterate and splice. This is O(n) in table size — acceptable for in-memory tables. Other vtab modules implement `alterTable` per their storage model, or omit it (engine errors on unsupported ALTER).

## TODO

- Create plan nodes for RENAME TABLE, RENAME COLUMN, ADD COLUMN, DROP COLUMN (or a single `AlterTableNode` with action variants)
- Create runtime emitters for each action
- Implement RENAME TABLE: schema entry replacement, view dependency check (error or cascade), schema change notification
- Implement RENAME COLUMN: column name update, columnIndexMap rebuild, PK/index/constraint cascade check (error if referenced by CHECK constraints for now), schema change notification
- Implement ADD COLUMN: column creation from AST, NOT NULL + DEFAULT validation, PK column rejection, extend `VirtualTableModule` interface with optional `alterTable`, implement in MemoryTable, schema change notification
- Implement DROP COLUMN: PK column rejection, constraint/index dependency check, column removal, `alterTable` call, index cleanup, schema change notification
- Update `buildAlterTableStmt()` in `alter-table.ts` to route to new plan nodes
- Update declarative schema differ to generate ALTER TABLE for column additions/removals (currently only tracks `columnsToAdd`/`columnsToDrop`)
- Tests: RENAME TABLE (basic, with view dependency error), RENAME COLUMN (basic, PK column), ADD COLUMN (with default, NOT NULL validation, backfill verification), DROP COLUMN (basic, PK rejection, constraint dependency error)
- Update `docs/sql.md` ALTER TABLE section
