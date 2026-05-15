---
description: Surface displaced underlying-store row as `replacedRow` from IsolatedTable.update so INSERT OR REPLACE / UPDATE OR REPLACE fire ON DELETE cascades when the conflict lives only in the underlying store
prereq: none
files:
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus/test/logic.spec.ts
  - packages/quereus/test/logic/41-foreign-keys.sqllogic
---

## Root cause

`IsolatedTable.checkMergedPKConflict` previously returned `null` for the REPLACE
case against an underlying-store row, comment-ed "same-PK replace: flush will
UPDATE underlying".  That comment is correct for *data persistence* (the overlay
inserts the new row, and at flush the same-PK collision becomes an UPDATE on the
underlying), but it loses information that the DML executor needs at the moment
of the INSERT: the row being displaced.

The DML executor (`packages/quereus/src/runtime/emit/dml-executor.ts`
`processInsertRow` and `runUpdate`) decides whether to fire FK delete cascades
by inspecting `UpdateResult.replacedRow`.  With `replacedRow === undefined`,
INSERT OR REPLACE on a parent whose conflict lives only in the store silently
behaved as a plain insert, leaving children that ON DELETE CASCADE / SET NULL /
SET DEFAULT would otherwise have touched.

The memory module's `LayerManager.insertIntoTable` populates `replacedRow` for
the same scenario, which is why memory mode already worked.

## Fix

Reshaped `checkMergedPKConflict` to return a discriminated outcome:

```ts
{ terminating?: UpdateResult; replacedUnderlyingRow?: Row }
```

- `terminating` — short-circuit (IGNORE / constraint error) as before.
- `replacedUnderlyingRow` — present when REPLACE applied against a row that
  lives only in the underlying store.  Caller captures it and threads it onto
  the overlay's success result via the new `attachReplacedUnderlying` helper.

All three callers were updated:

1. `case 'insert'` — same-PK INSERT OR REPLACE against an underlying row.
2. `case 'update'` with existing overlay row + PK change — REPLACE at new PK in
   underlying.
3. `case 'update'` with no existing overlay row + PK change — same.

`stripTombstoneFromResult` was extended to preserve any `replacedRow` the
overlay's memory module emits natively (e.g. when both old & new are in the
overlay).  `attachReplacedUnderlying` only overrides it when we have a
store-side displacement to report.

## Test surface

- Removed `41-foreign-keys.sqllogic` from `MEMORY_ONLY_FILES` in
  `packages/quereus/test/logic.spec.ts`.  Existing OR REPLACE FK cascade
  assertions in that file (lines 673-725: ON DELETE CASCADE and ON DELETE SET
  NULL via INSERT OR REPLACE on parent) now exercise the store-mode path.
- `yarn test` (memory): 3098 passing, 0 failing.
- `QUEREUS_TEST_STORE=1 yarn test`: 652 passing, 1 failing.  The single failure
  is `41.4-alter-add-column-constraints.sqllogic` ("Cannot add NOT NULL column
  ... to non-empty table"), pre-existing on `fd` before this change (verified
  via `git stash` baseline: 651 passing, same single failure).
- Workspace `yarn test`: no new failures.  Two pre-existing failures in
  `sample-plugins` "Comprehensive Demo Plugin" remain (verified pre-existing).

## Notes for review

- UC-conflict REPLACE (non-PK UNIQUE) still does not surface `replacedRow` —
  matches the memory module's behavior (`checkUniqueViaIndex` /
  `checkUniqueByScanning` both just `recordDelete` the evicted row and return
  `null`).  If a follow-up wants to fire FK cascade on UC-displaced rows, both
  layers would need to change together; out of scope for this ticket.
- ON DELETE SET DEFAULT was not separately tested in 41-foreign-keys for the
  OR REPLACE path; the same `executeForeignKeyActions(...'delete', ...)` call
  in dml-executor handles all three (CASCADE / SET NULL / SET DEFAULT) once
  `replacedRow` is populated, so coverage for CASCADE + SET NULL is sufficient
  evidence that the wiring is correct.
- The pre-existing `41.4-alter-add-column-constraints.sqllogic` failure is
  unrelated (alterTable on non-empty store-backed table) and should be tracked
  separately if it isn't already.
