description: FK `on delete cascade` leaves orphaned child rows when using the store-module (IndexedDB-backed) vtab
dependencies:
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/fk-cascade.spec.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
----

## Root Cause

`StoreTable.update()` for `case 'delete'` returned `{ status: 'ok' }` without a `row` field. In `dml-executor.ts:runDelete` (line 532), the code checks `if (!result.row) { continue; }` — interpreting a missing `row` as "row not found, skip". This skipped `executeForeignKeyActions()` (line 540) and the auto-event emission (line 543), so FK cascades and data change events never fired for store-backed tables.

The memory vtab's `performDelete` returns `{ status: 'ok', row: oldRowData }`, which is why cascade works there.

## Fix

One-line change in `packages/quereus-store/src/common/store-table.ts` line 612:

```diff
- return { status: 'ok' };
+ return { status: 'ok', row: oldRow || undefined };
```

This aligns the store module's delete result with the memory vtab contract: return the old row data so the DML executor can proceed with FK cascading and event emission.

## Tests

New test file: `packages/quereus-store/test/fk-cascade.spec.ts`

- **removes child rows when parent is deleted** — basic cascade with 2 children
- **removes all child rows when all parents are deleted** — bulk parent delete
- **cascades through multiple levels** — parent → child → grandchild three-level cascade
- **emits data change events for cascaded child deletes** — verifies delete events fire for both child and parent rows

## Validation

- `yarn workspace @quereus/store test` — 168 passing
- `yarn workspace @quereus/quereus test` — 1917 passing
- `yarn workspace @quereus/store build` — clean
