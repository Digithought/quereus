---
description: Review public Database.getTable() handle that exposes per-table event subscription
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/table-handle.ts          # NEW
  - packages/quereus/src/vtab/events.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/vtab-events.spec.ts
  - docs/usage.md
---

## What landed

Adds a public `Database.getTable(schemaName, tableName)` method that returns a
narrow `Table` handle exposing per-table event subscription via the existing
module-level `VTableEventEmitter`.

### Changes

- **NEW** `packages/quereus/src/core/table-handle.ts` — exports the public
  `Table` class. Fields: `schemaName`, `tableName`, `schema` (frozen reference
  to `TableSchema`), `moduleName`. Stores `db` + `module` privately. Single
  method: `getEventEmitter(): VTableEventEmitter | undefined` that delegates
  to the shared `tryGetEventEmitter()` helper. Constructor marked `@internal`
  (TS-only; the runtime constructor is still callable, but no external code
  is documented to do so — handles are produced solely by `Database.getTable`).

- `packages/quereus/src/vtab/events.ts` — exported `tryGetEventEmitter(module)`
  (lifted from `core/database.ts`). Same predicate used by both the
  database-level hook path and the new `Table` handle, so the two paths cannot
  drift.

- `packages/quereus/src/core/database.ts` — removed the local
  `tryGetEventEmitter` helper, imports the shared one from `vtab/events.js`,
  and adds the public `getTable(schemaName, tableName): Table | undefined`
  method (near `_findTable`). Implementation: looks up the table schema via
  the schema manager, resolves its `vtabModuleName`, fetches the module
  registration, and returns a fresh `Table` snapshot. Returns `undefined` for
  unknown tables or missing modules. Calls `checkOpen()` first.

- `packages/quereus/src/index.ts` — exports `Table` from `core/table-handle.js`.

- `packages/quereus/test/vtab-events.spec.ts` — un-skipped the
  `getEventEmitter API` block. Added three new tests inside it:
  1. Unknown table returns `undefined` (case variations).
  2. Unsubscribe stops further events.
  3. Post-DROP: handle keeps its emitter reference, `db.getTable` returns
     `undefined`, no events fire for the dropped name.

- `docs/usage.md` — added a "Per-Table Subscription via `db.getTable(...)`"
  subsection within the Event System, after "Subscribing to Schema Changes"
  and before "Transaction Batching". Documents the module-shared-emitter
  caveat, the snapshot lifecycle, and the fallback to `db.onDataChange()` for
  modules without native event support.

## Validation

- `yarn workspace @quereus/quereus run test` — 3156 passing, no failures.
  The previously-skipped `getEventEmitter API` block now runs (5 tests) and
  passes.
- `yarn workspace @quereus/quereus run lint` — exit 0, no findings.
- `yarn workspace @quereus/quereus run build` — exit 0.

## Use cases / what to verify

Spec-level:

- `db.getTable('main', 'users')` returns a `Table` after CREATE TABLE.
- `db.getTable('main', 'no_such_table')` returns `undefined` (no throw, no
  case-sensitivity surprises — `schemaManager.getTable` already handles
  case-insensitive lookup).
- `handle.getEventEmitter()` returns the **exact same** emitter instance the
  caller passed to `new MemoryTableModule(emitter)` — confirmed by the
  un-skipped `should expose event emitter from table` test
  (`assert.equal(tableEmitter, emitter)`).
- The handle's emitter receives data-change events for the table after INSERT.
- Unsubscribe returned by `onDataChange` actually detaches.
- After DROP TABLE, `db.getTable` returns `undefined`, but a previously
  acquired handle still resolves its emitter (the module instance outlives
  individual tables).

Module-shared-emitter caveat (documented):

- Multiple tables under the same module share one emitter. A subscription via
  `db.getTable('main', 'users').getEventEmitter()` will fire for **every**
  table in that module, not just `users`. Consumers filter by
  `event.tableName`. This matches the failing-spec expectation and the
  existing `VirtualTable.getEventEmitter?()` shape; per-table filtered
  subscriptions are deferred (listed as out of scope in the plan ticket).

## Known gaps / things to scrutinize

- **Constructor visibility.** `Table` has `/** @internal */` on the
  constructor but it is publicly callable from JS. If keeping the boundary
  honest matters (vs. just by TS documentation), consider a runtime guard
  using a symbol, or an unexported class + factory. The plan ticket
  explicitly said "no constructor is exposed publicly" but does not specify
  enforcement strength — I followed the lighter convention used elsewhere in
  the codebase (e.g. `Statement`).
- **`db` field unused at runtime.** The handle stores the `Database`
  reference but doesn't currently use it for anything (the emitter comes from
  the module). It's kept for forward-compatibility with potential future
  features (filtered subscriptions, re-resolution on schema change). Reviewer
  may want to drop it if you'd prefer to delete-now-add-later.
- **`schema` is a live reference, not a clone.** The handle exposes the
  internal `TableSchema` object. If the schema manager later mutates that
  object in-place (column add/drop), the handle's `schema` reflects the
  mutation. The plan ticket's wording was "frozen reference" — I read that
  as "the reference itself doesn't change," not "deep-frozen copy." Worth
  confirming this is the intended contract.
- **No test for the `undefined` schemaName overload.** `db.getTable(undefined,
  'users')` should resolve via the current default schema — the
  `schemaManager.getTable` path already handles this, but it's not exercised
  by the new tests. Low risk, but cheap to add if you want belt+braces.
- **`docs/usage.md` doesn't mention `Table` in the API reference section**
  (line ~404). The new content is only in the Event System section. Add a
  short bullet under "Database API Reference" if you want symmetry with
  `db.exec` / `db.prepare` / `db.eval`.

## Test floor

Five tests in the `getEventEmitter API` block (two existing, three new). The
post-DROP test verifies the contract but does not re-create the table with the
same name and confirm no leakage into the stale filter — the comment notes
this. Reviewer should treat the test count as a floor, not the ceiling.
