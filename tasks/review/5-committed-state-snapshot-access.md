---
description: Review committed.tablename pseudo-schema for accessing pre-transaction state
dependencies: MVCC layer system, schema-resolution, memory module
---

## Summary

Implemented `committed.tablename` pseudo-schema that provides read-only access to the pre-transaction (committed) state of tables. This enables assertions and deferred constraints to compare current state against the committed baseline.

### Changes

1. **`TableReferenceNode`** (`planner/nodes/reference.ts`): Added `readCommitted` boolean flag to constructor, included in `toString()` and `getLogicalAttributes()`.

2. **Schema resolution** (`planner/building/schema-resolution.ts`): Added `COMMITTED_SCHEMA` constant and `isCommittedSchemaRef()` helper. `resolveTableSchema()` intercepts `committed` pseudo-schema and resolves the real table via default search path.

3. **`buildTableReference`** (`planner/building/table.ts`): Detects `committed` schema qualifier and passes `readCommitted: true` to `TableReferenceNode`.

4. **Runtime emission** (`runtime/emit/scan.ts`): When `source.readCommitted` is true, merges `_readCommitted: true` into the module connect options.

5. **`BaseModuleConfig`** (`vtab/module.ts`): Added optional `_readCommitted` field.

6. **`MemoryTableConfig`** (`vtab/memory/types.ts`): Added optional `_readCommitted` field.

7. **`MemoryTableModule.connect()`** (`vtab/memory/module.ts`): Passes `_readCommitted` to `MemoryTable` constructor.

8. **`MemoryTable`** (`vtab/memory/table.ts`):
   - Added `readCommitted` field
   - `ensureConnection()`: In committed-snapshot mode, creates an unregistered connection (no `db.registerConnection()`, no `begin()`)
   - `query()`: In committed-snapshot mode, always reads from `conn.readLayer` (ignores `pendingTransactionLayer`)
   - `update()`: Throws `"Cannot modify committed-state snapshot"` error in committed-snapshot mode

9. **DML enforcement** (`planner/building/insert.ts`, `update.ts`, `delete.ts`): Early check rejects DML targeting `committed.*` tables at plan time.

### Testing

**Test file:** `packages/quereus/test/logic/42-committed-snapshot.sqllogic`

Tests cover:
- Basic `SELECT * FROM committed.tablename` returns pre-transaction data within a transaction
- `committed.*` outside a transaction returns current data
- `committed.*` is read-only (INSERT/UPDATE/DELETE produce errors)
- JOINs between current and committed state
- Multiple tables with committed references
- Savepoint interaction: committed state doesn't change after savepoints
- Assertion with committed reference catches violations (balance decrease)
- Assertion with committed reference passes when constraint holds (monotonic values)

### Key Design Decisions

- **Committed = transaction-start state**: `committed.*` always refers to `currentCommittedLayer`, which is set at transaction begin and doesn't change during the transaction (including across savepoints).
- **Unregistered connections**: Committed-snapshot `MemoryTable` instances create connections via `manager.connect()` but skip `db.registerConnection()`. This prevents them from receiving transaction lifecycle events (begin/commit/rollback), keeping them pinned to the committed layer.
- **Dual enforcement**: Read-only is enforced both at plan time (DML builders reject `committed.*` targets) and at runtime (MemoryTable.update() throws).
