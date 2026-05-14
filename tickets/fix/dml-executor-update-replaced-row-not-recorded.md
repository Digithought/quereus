---
description: UPDATE path in `dml-executor.ts` drops `result.replacedRow`. When a column-level (or `OR REPLACE`) PK collision causes a PK-change UPDATE to evict an existing row at the new PK, the displaced row is silently removed by the vtab but never surfaced to change tracking (`_recordUpdate`/`_recordDelete`), FK cascade processing (`executeForeignKeyActions`), or auto-event emission (`emitAutoDataEvent`). The INSERT path handles `replacedRow` correctly (see dml-executor.ts:422-437); the UPDATE path needs equivalent handling.
prereq:
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
---

## Background

The implement-stage diff for `dml-executor-update-path-default-conflict`
taught the memory module's `performUpdateWithPrimaryKeyChange` to handle
`REPLACE`. It correctly returns
`{ status: 'ok', row: newRowData, replacedRow: existingRowAtNewKey }`
when the new PK was occupied and REPLACE applies.

The UPDATE-path executor at `dml-executor.ts` ~line 506–545 only reads
`result.row`. It does not read `result.replacedRow`, so the displaced row
at the new PK is invisible to:

1. **Change tracking** — `_recordUpdate(table, oldRow, newRow, pk)` is
   called for the old→new move, but no `_recordDelete` is recorded for
   the row that was evicted at the new PK. Reactive subscribers
   (`DeltaExecutor`, change-feed listeners) miss that deletion.
2. **FK cascade processing** — `executeForeignKeyActions(db, table,
   'update', oldRow, newRow)` runs for the moved row, but no `'delete'`
   FK action runs for the evicted row. Child rows that depended on the
   evicted row's PK via `ON DELETE CASCADE`/`SET NULL`/`SET DEFAULT` are
   left dangling.
3. **Auto-event emission** — `emitAutoDataEvent` is called once for the
   update, but no `'delete'` event is emitted for the evicted row.
   Modules without native event support (`hasNativeEventSupport(vtab) ===
   false`) won't see the deletion.

The INSERT-path executor at `dml-executor.ts` ~line 417–447 already
handles this correctly when `INSERT OR REPLACE` evicts an existing row
(records the eviction as an UPDATE old→new, runs FK delete cascades,
emits an update auto-event). The UPDATE path should be the same shape —
but it must additionally also account for the *moved* row (old PK →
new PK), which the INSERT path does not have.

## Expected behavior

For a UPDATE-with-REPLACE that moves a row from PK_old to PK_new where
PK_new was occupied by row R_evicted, the executor should record /
cascade as if these three operations happened:

- DELETE at PK_old of `oldRow` (the source row's old position)
- DELETE at PK_new of `R_evicted` (the displaced row)
- INSERT at PK_new of `newRow`

Equivalent two-event collapse is acceptable (single UPDATE old→new plus a
DELETE of R_evicted) so long as all three downstream paths (change
tracking, FK cascade, auto-events) see the eviction.

## Test gaps to fill

Section 7 of `29.1-column-level-conflict-clause.sqllogic` covers data
state post-UPDATE-REPLACE but not the side-effects. Add cases that:

- Declare a child table with `FOREIGN KEY (parent_id) REFERENCES
  parent(id) ON DELETE CASCADE` and verify children of the *evicted*
  parent row are cascaded.
- Subscribe to data events (or rely on `change_log` queries if exposed in
  the test harness) and verify a `delete` event fires for the displaced
  row.

## Scope note

This gap predates `dml-executor-update-path-default-conflict` — no UPDATE
path ever consumed `replacedRow`. The new column-level-REPLACE-on-UPDATE
code path is the first user that can actually reach the gap, which is
why it surfaced now.
