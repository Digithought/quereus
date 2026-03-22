description: UPSERT DO UPDATE and INSERT OR REPLACE now execute FK cascading actions
dependencies: none
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----

## Summary

Added missing `executeForeignKeyActions` calls in two code paths within `dml-executor.ts`:

1. **UPSERT DO UPDATE path** (~line 321): When an INSERT with ON CONFLICT DO UPDATE resolves to the update path, FK cascading actions (CASCADE, SET NULL, SET DEFAULT) now fire on the parent table mutation, matching the behavior of the regular UPDATE path.

2. **INSERT OR REPLACE path** (~line 368): When INSERT OR REPLACE replaces an existing row, FK cascading actions now fire as a `'delete'` operation on the replaced row. REPLACE is semantically delete+insert, so ON DELETE CASCADE / SET NULL / SET DEFAULT fire on child rows referencing the old parent key.

## Changes

### `packages/quereus/src/runtime/emit/dml-executor.ts`
- Line ~321: Added `await executeForeignKeyActions(ctx.db, tableSchema, 'update', result.existingRow!, updateResult.updatedRow)` after the UPSERT DO UPDATE success path records the update.
- Line ~368: Added `await executeForeignKeyActions(ctx.db, tableSchema, 'delete', replacedRow)` after the REPLACE path records the update.

### `packages/quereus/test/logic/41-foreign-keys.sqllogic`
New test sections appended:
- **UPSERT DO UPDATE with FK CASCADE**: Tests ON UPDATE CASCADE and ON UPDATE SET NULL when parent PK is changed via UPSERT.
- **INSERT OR REPLACE with FK CASCADE**: Tests ON DELETE CASCADE and ON DELETE SET NULL when parent row is replaced.

## Testing Notes
- All 182 quereus tests pass (1 pre-existing unrelated failure in `alterTable` stringification).
- Build succeeds.
- Key test cases to validate:
  - UPSERT that changes parent PK cascades to child FK columns
  - UPSERT with SET NULL cascades to child FK columns
  - REPLACE triggers ON DELETE CASCADE on child rows
  - REPLACE triggers ON DELETE SET NULL on child rows
  - Existing FK tests (regular UPDATE/DELETE cascade) still pass
  - Existing UPSERT tests (47-upsert.sqllogic) still pass
