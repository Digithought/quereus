---
description: Review IsolatedTable.update changes that surface displaced underlying-store rows as `replacedRow` so INSERT/UPDATE OR REPLACE fire ON DELETE cascades when the conflict lives only in the underlying store
files:
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus/test/logic.spec.ts
  - packages/quereus/test/logic/41-foreign-keys.sqllogic
---

## What changed

Implementation landed in commit `216889ff`.

`IsolatedTable.checkMergedPKConflict` used to return `null` for the REPLACE
case against a row that lived only in the underlying store, on the reasoning
that flush would convert the same-PK insert into an UPDATE on the underlying.
That is correct for *data persistence* but loses the displaced row, which the
DML executor (`packages/quereus/src/runtime/emit/dml-executor.ts`
`processInsertRow` / `runUpdate`) needs in `UpdateResult.replacedRow` to fire
FK ON DELETE CASCADE / SET NULL / SET DEFAULT actions on children of the
displaced parent.

The fix reshapes `checkMergedPKConflict` to a discriminated outcome:

```ts
{ terminating?: UpdateResult; replacedUnderlyingRow?: Row }
```

- `terminating` — short-circuit (IGNORE / constraint error), as before.
- `replacedUnderlyingRow` — set when REPLACE displaces an underlying-only row;
  caller threads it through via a new `attachReplacedUnderlying` helper which
  overrides the overlay-success result's `replacedRow`.

Three call sites consume the new outcome:

1. `case 'insert'` — INSERT OR REPLACE with same PK as an underlying row.
2. `case 'update'` with an existing overlay row + PK change.
3. `case 'update'` with no existing overlay row + PK change.

`stripTombstoneFromResult` was widened to forward any `replacedRow` the
overlay's memory module emits natively (the overlay-only displacement path);
`attachReplacedUnderlying` only overrides when we have a store-side
displacement to report.

Memory mode was already correct because `LayerManager.insertIntoTable`
populates `replacedRow` for the same scenario — this change brings the
isolation layer's store-mode behavior in line.

## What to verify

- Read `packages/quereus-isolation/src/isolated-table.ts` lines ~644–786
  (the three switch arms) and ~1002–1026 (`checkMergedPKConflict`) and
  ~852–869 (`stripTombstoneFromResult` / `attachReplacedUnderlying`).
- Confirm the three callers correctly thread `pkOutcome.replacedUnderlyingRow`
  into the final `UpdateResult`.
- Check that the overlay-emitted `replacedRow` (memory module path) survives
  the strip — see `stripTombstoneFromResult` returning `result.replacedRow`.

## Test surface

- `packages/quereus/test/logic/41-foreign-keys.sqllogic` (lines ~673–725)
  exercises ON DELETE CASCADE and ON DELETE SET NULL via INSERT OR REPLACE on
  parent. The file was removed from `MEMORY_ONLY_FILES` in
  `packages/quereus/test/logic.spec.ts` (line ~43), so it now runs in store
  mode too.
- `yarn workspace @quereus/quereus run test` — 3098 passing, 0 failing
  (memory mode; re-verified this run).
- `QUEREUS_TEST_STORE=1 yarn workspace @quereus/quereus run test` —
  652 passing, 1 failing (store mode; re-verified). The single failure is
  `41.4-alter-add-column-constraints.sqllogic` (`Cannot add NOT NULL column
  ... to non-empty table`), which is **pre-existing on `fd`** and unrelated
  to this change — see ticket comment in the source file.

## Known gaps / scope notes

- **UC-conflict REPLACE not surfaced.** A non-PK UNIQUE conflict resolved via
  REPLACE still does not produce `replacedRow`. This matches the memory
  module's behavior (`checkUniqueViaIndex` / `checkUniqueByScanning` evict
  via `recordDelete` and return `null`). Fixing that would require coordinated
  changes in both the memory `LayerManager` and `IsolatedTable`, and was out
  of scope for this ticket. Reviewer may want to file a follow-up.
- **ON DELETE SET DEFAULT not separately covered.** Only CASCADE and SET NULL
  have OR REPLACE coverage in `41-foreign-keys.sqllogic`. The same
  `executeForeignKeyActions(...'delete', ...)` path in dml-executor handles
  all three actions once `replacedRow` is populated, so the existing coverage
  is reasonable evidence the wiring works — but it's not direct proof. A
  reviewer could add a SET DEFAULT case if they want belt-and-suspenders.
- **Pre-existing store-mode failure.** `41.4-alter-add-column-constraints`
  fails on `fd` independent of this change. Verified by stashing and re-running
  (651/1 vs 652/1 — same failure). Worth tracking separately if not already.

## Quick reproducer (memory mode is enough)

```sql
create table parent(id integer primary key, val text);
create table child(id integer primary key, p integer references parent(id) on delete cascade);
insert into parent values(1, 'a');
insert into child values(10, 1);
-- Before fix in store mode: child row at 10 survives this INSERT OR REPLACE.
-- After fix: child row at 10 is cascaded out.
insert or replace into parent values(1, 'b');
select count(*) from child;  -- expect 0
```
