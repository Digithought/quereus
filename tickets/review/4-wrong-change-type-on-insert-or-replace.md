description: INSERT OR REPLACE now emits correct 'update' change type when replacing an existing row
dependencies: none
files:
  - packages/quereus/src/common/types.ts (UpdateResult — added optional `replacedRow` field)
  - packages/quereus/src/runtime/emit/dml-executor.ts (runInsert — checks replacedRow, emits 'update' with oldRow/changedColumns)
  - packages/quereus/src/vtab/memory/layer/manager.ts (performInsert — returns replacedRow on REPLACE)
  - packages/quereus-store/src/common/store-table.ts (insert case — emits 'update' event when replacing, returns replacedRow)
  - packages/quereus/test/database-events.spec.ts (4 new INSERT OR REPLACE tests)
  - packages/quereus/test/vtab-events.spec.ts (3 new INSERT OR REPLACE tests)
----

## What was fixed

Two code paths emitted `type: 'insert'` instead of `type: 'update'` when `INSERT OR REPLACE` replaced an existing row:

1. **DML executor auto-emit path** (vtabs without native event support): `runInsert()` always called `_recordInsert()` and emitted insert events. Now checks `result.replacedRow` and branches to emit 'update' with proper `oldRow`, `newRow`, and `changedColumns`.

2. **quereus-store native event path**: `store-table.ts` insert case always emitted `type: 'insert'`. Now deserializes the existing row before overwrite, emits 'update' event when replacing, and returns `replacedRow` in UpdateResult.

## Approach

- Extended `UpdateResult` ok variant with optional `replacedRow?: Row` — backwards-compatible, vtabs that don't return it continue to work as fresh inserts.
- Memory vtab `performInsert` returns `replacedRow: existingRow` on REPLACE conflict resolution.
- Store-table deserializes existing row before put, emits correct event type, and returns `replacedRow`.

## Test cases for review

All in the "INSERT OR REPLACE Events" describe blocks:

**database-events.spec.ts** (auto-emit path):
- Replace existing row → emits 'update' with correct oldRow, newRow, changedColumns
- Insert new row via INSERT OR REPLACE → emits 'insert'
- Partial change on replace → changedColumns only includes actually-changed columns
- INSERT OR REPLACE inside transaction → events batch correctly, emitted on commit

**vtab-events.spec.ts** (native events path — memory module with emitter):
- Replace existing row → emits 'update' with correct oldRow, newRow, changedColumns
- Insert new row via INSERT OR REPLACE → emits 'insert'
- INSERT OR REPLACE inside transaction → events batch correctly

All 45 event tests pass. The only test failure in the full suite is a pre-existing issue in `08.1-semi-anti-join.sqllogic` (unrelated).
