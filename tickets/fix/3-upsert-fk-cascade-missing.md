description: UPSERT DO UPDATE and INSERT OR REPLACE paths don't execute FK cascading actions
dependencies: none
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/test/logic/47-upsert.sqllogic
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----
When an INSERT with ON CONFLICT DO UPDATE resolves to the update path, or when INSERT OR REPLACE replaces an existing row, the `executeForeignKeyActions` call is missing. The normal UPDATE path in `runUpdate` (line ~451) correctly calls `executeForeignKeyActions(ctx.db, tableSchema, 'update', oldRow, newRow)`, but neither the UPSERT update path (around line 310) nor the REPLACE path (around line 357) makes this call.

This means if a parent table row is updated via UPSERT or replaced via INSERT OR REPLACE, child table rows with ON UPDATE CASCADE / ON DELETE CASCADE / SET NULL / SET DEFAULT foreign keys won't have their cascading actions executed.

**Impact**: Data integrity violation — child rows may reference stale parent keys after UPSERT/REPLACE operations on parent tables.

**Fix approach**:
- In the UPSERT DO UPDATE success path (~line 310), add: `await executeForeignKeyActions(ctx.db, tableSchema, 'update', result.existingRow, updateResult.updatedRow)`
- In the INSERT OR REPLACE path (~line 357), add: `await executeForeignKeyActions(ctx.db, tableSchema, 'update', replacedRow, newRow)` (treat replace as update for FK purposes)
- Add test cases combining UPSERT/REPLACE with FK CASCADE on parent tables

## TODO
- Add FK cascade test cases for UPSERT DO UPDATE on parent table
- Add FK cascade test cases for INSERT OR REPLACE on parent table
- Add `executeForeignKeyActions` call in the UPSERT update success path
- Add `executeForeignKeyActions` call in the REPLACE path
- Verify existing FK tests still pass
