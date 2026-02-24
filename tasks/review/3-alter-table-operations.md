---
description: Review ALTER TABLE operations (RENAME TABLE, RENAME COLUMN, ADD COLUMN, DROP COLUMN)
dependencies: none

---

## Summary

Implemented the four remaining ALTER TABLE operations that previously threw UNSUPPORTED.

### What was done

**Plan node**: `AlterTableNode` (`src/planner/nodes/alter-table-node.ts`) — single node with discriminated action union for all 4 operations.

**Planner**: Updated `buildAlterTableStmt()` in `src/planner/building/alter-table.ts` to route all 4 actions to `AlterTableNode`.

**Runtime emitter**: `src/runtime/emit/alter-table.ts` — handles each operation:
- **RENAME TABLE**: Updates schema catalog (remove old/add new name), updates MemoryTableModule's internal tables Map key, notifies schema change.
- **RENAME COLUMN**: Clones column with new name, calls `module.alterTable()` for module-aware rename, updates catalog.
- **ADD COLUMN**: Validates (no duplicate, no PK, NOT NULL requires DEFAULT if table has rows), calls `module.alterTable()` for data backfill.
- **DROP COLUMN**: Validates (no PK drop, not last column), calls `module.alterTable()` for data removal.

**VirtualTableModule interface** (`src/vtab/module.ts`): Added optional `alterTable()` method returning updated `TableSchema`.

**MemoryTableModule** (`src/vtab/memory/module.ts`): Implemented `alterTable()` delegating to manager, plus `renameTable()` for table key management.

**MemoryTableManager** (`src/vtab/memory/layer/manager.ts`): Implemented `addColumn()`, `dropColumn()`, `renameColumn()` with latch-based concurrency, schema safety consolidation, and base layer data migration.

**Bug fix — stale connection readLayer**: After ALTER TABLE ADD COLUMN with intervening DML, queries could read from outdated transaction layers. Fixed in `ensureConnection()` (`src/vtab/memory/table.ts`) by syncing `readLayer` with `manager.currentCommittedLayer` when reusing a connection from the same manager.

**Bug fix — NOT NULL validation**: `addColumn` now allows NOT NULL without DEFAULT on empty tables (SQLite-compatible).

### Testing

- `test/logic/41-alter-table.sqllogic` — comprehensive sqllogic tests covering all 4 operations, error cases, and combined operations
- `test/vtab-events.spec.ts` — updated ADD COLUMN event test (was failing due to NOT NULL validation)
- 730 tests passing, 0 failing

### Documentation

- `docs/sql.md` — added section 2.7 documenting ALTER TABLE syntax and restrictions

### Key files

- `packages/quereus/src/planner/nodes/alter-table-node.ts` (new)
- `packages/quereus/src/runtime/emit/alter-table.ts` (new)
- `packages/quereus/test/logic/41-alter-table.sqllogic` (new)
- `packages/quereus/src/planner/building/alter-table.ts`
- `packages/quereus/src/vtab/module.ts`
- `packages/quereus/src/vtab/memory/module.ts`
- `packages/quereus/src/vtab/memory/table.ts`
- `packages/quereus/src/vtab/memory/layer/manager.ts`
- `packages/quereus/src/vtab/memory/layer/base.ts`
- `docs/sql.md`
