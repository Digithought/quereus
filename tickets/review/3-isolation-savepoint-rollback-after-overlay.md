---
description: Review the savepoint-stack replay on lazy connection registration — fixes ROLLBACK TO landing on lazily-attached vtab connections (memory, isolation, anything that lazily registers).
prereq:
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-transaction.ts
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - packages/quereus/test/logic.spec.ts
  - packages/quereus/test/logic/04a-savepoint-lazy-attach.sqllogic
---

## What landed

The root cause in the fix-stage ticket was: `Database.registerConnection`
called `connection.begin()` when registering a `VirtualTableConnection`
mid-transaction, but did **not** replay the active savepoint stack onto the
freshly-registered connection. Any SAVEPOINTs taken before the connection
existed were invisible to it, so a subsequent `ROLLBACK TO` / `RELEASE`
targeting one of those depths silently no-op'd out-of-range on the new
connection.

This affected every vtab module that registers connections lazily on first
read/write:

1. Memory module's `MemoryVirtualTableConnection` (`MemoryTable.ensureConnection`).
2. Isolation layer's covering `IsolatedConnection` (`IsolatedTable.ensureConnection`).
3. The overlay's `MemoryVirtualTableConnection` registered by
   `IsolatedTable.ensureOverlay`'s pre-alignment path.

### Changes

- **`TransactionManager.getActiveSavepointDepth()`** (new) —
  `packages/quereus/src/core/database-transaction.ts`. Depth-only API; no name
  leakage.

- **`Database.registerConnection`** — after the successful `connection.begin()`
  branch, replay each savepoint depth `i ∈ [0, activeDepth)` by calling
  `await connection.createSavepoint(i)`. Errors are logged and replay continues,
  matching the `begin()` path's robustness.

- **`IsolatedTable.ensureOverlay`** — removed the explicit `createSavepoint(depth)`
  loop over `savepointsBeforeOverlay`. With the replay in
  `Database.registerConnection`, the loop becomes a double-push and corrupts
  the overlay's `MemoryVirtualTableConnection.savepointStack` (broke the
  existing `mixed pre/post-overlay savepoints` test). We still pre-register
  the `preAlignedConn` so `MemoryTable.ensureConnection` reuses it instead of
  creating a fresh one on the first `overlay.update()` (which would then skip
  the registerConnection replay path entirely).

- **`logic.spec.ts`** — `04-transactions.sqllogic` removed from
  `MEMORY_ONLY_FILES`. It now passes in store mode.

- **`test/logic/04a-savepoint-lazy-attach.sqllogic`** (new) — four cases
  exercising the bug from SQL:
  1. SAVEPOINT before any access → INSERT → ROLLBACK TO undoes it.
  2. Nested savepoints before any access → INSERT inside → ROLLBACK TO
     outer + RELEASE outer.
  3. Prior committed write + nested savepoints inside tx → ROLLBACK TO
     inner keeps outer-era write, ROLLBACK TO outer clears it, committed
     base intact.
  4. SELECT-before-SAVEPOINT (isolation-specific): IsolatedConnection
     exists before the savepoint so the pre-existing
     `savepointsBeforeOverlay` path still fires. Verifies that path
     remains correct after the registerConnection replay was added.

- **`isolation-layer.spec.ts`** (new test) — `savepoint before any access:
  rollback to savepoint undoes lazy-registered connection writes`. Focused
  regression for Case 1 using the IsolationModule + MemoryTable harness.

## Validation

- `yarn test` — green. 3099 quereus passing + 68 isolation passing. The only
  failure is a pre-existing `sample-plugins`/`Comprehensive Demo Plugin`
  delete/update test issue, confirmed to fail on `main` without my changes
  (the demo plugin shares state via a module-level `Map`). Unrelated.
- `yarn test:store` — green for everything in scope. The only failure is a
  pre-existing `41.4-alter-add-column-constraints.sqllogic` failure
  (`StoreModule.alterTable` NOT NULL backfill), confirmed to fail on `main`
  too. Unrelated.
- I confirmed both pre-existing failures appear on `main` (without my
  changes) by stashing and re-running.

## Known gaps / things to double-check

- **The `savepointsBeforeOverlay` set is now partially redundant.** The
  registerConnection replay handles the alignment, but the set still drives
  two things:
  1. The guard in `ensureOverlay` (`savepointsBeforeOverlay.size > 0`) that
     decides whether to pre-register the overlay connection at all. If we
     unconditionally pre-register, this guard is unnecessary. I left it as
     a low-risk minimal change.
  2. `onConnectionRollbackToSavepoint` uses `savepointsBeforeOverlay.has(index)`
     to decide whether a pre-overlay rollback should clear the overlay
     entirely. This is the **only** case 4 path (read-before-savepoint).
     Removing the set would require redesigning that signal — out of scope
     for this ticket.
  Worth a reviewer's eye on whether the set should be removed entirely now
  (and what replaces signal #2).

- **Error handling in the replay loop swallows per-depth failures.** Matches
  the existing `begin()` failure handling (log, continue, don't throw). If a
  reviewer prefers stricter behavior, the entire register flow needs to
  reconcile.

- The replay calls `connection.createSavepoint(0)` … `(N-1)`. The connection
  interface guarantees only the depth index, not the savepoint name. This
  matches the existing semantics — `createSavepoint(index)` is name-free at
  the connection layer.

- No new tests for **store-module** lazy-connection-registration directly
  (only via the sqllogic file, which is now run in both modes). If a future
  store-specific edge case emerges, add it next to the isolation tests.

## Use cases worth re-testing during review

- The exact reproducer from the original fix-stage ticket:
  ```sql
  create table t1 (id integer primary key, v text);
  begin;
  savepoint sp;
  insert into t1 values (1, 'x');
  rollback to savepoint sp;
  select count(*) from t1;  -- expected 0
  ```
- All existing isolation savepoint tests (including
  `pre-overlay savepoint…clears overlay` and
  `mixed pre/post-overlay savepoints…`) — these stress the
  `savepointsBeforeOverlay` path and were the ones that broke first
  when I prototyped the wrong fix (double-push).

- `04-transactions.sqllogic` running in store mode — was excluded; now
  passes.
