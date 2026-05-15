---
description: Replay active savepoint stack onto VirtualTableConnections registered mid-transaction so rollback-to-savepoint reaches lazily-attached connections (overlay or otherwise)
prereq: isolation-savepoint-rollback-undefined-schema
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-transaction.ts
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/src/isolated-connection.ts
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus/test/logic.spec.ts
  - packages/quereus/test/logic/04-transactions.sqllogic
  - packages/quereus-isolation/test/isolation-layer.spec.ts
---

## Reproduction (confirmed in fix stage)

The original ticket framed this as an isolation-layer-only gap; the fix-stage
repro showed it triggers in **both** memory and store modes — i.e. it's a more
general engine bug exposed by any vtab module that registers its
`VirtualTableConnection` lazily on first read/write.

Minimal failing case (fails identically under `yarn test` and `yarn test:store`):

```sql
create table t1 (id integer primary key, v text);
begin;
savepoint sp;                 -- broadcast to ALL active connections; t1 has none yet
insert into t1 values (1, 'x'); -- first access creates+registers t1's connection NOW
rollback to savepoint sp;     -- target depth 1 is out of range for t1's connection
select count(*) from t1;      -- expected 0, actual 1 — write was not rolled back
```

`MemoryTableConnection.rollbackToSavepoint` logs a warning when `targetDepth >=
savepointStack.length` and returns silently (see
`packages/quereus/src/vtab/memory/layer/connection.ts:170-176`). The insert
stays alive.

## Root cause

`Database.registerConnection` (`packages/quereus/src/core/database.ts:1436-1454`)
calls `connection.begin()` when the DB is mid-transaction, but does **not**
replay the active savepoint stack onto the freshly-registered connection. Any
SAVEPOINTs taken before this connection existed are invisible to it, so a
subsequent `ROLLBACK TO` / `RELEASE` targeting one of those depths is silently
out-of-range on this connection.

This bites three sets of connections:

1. **Memory-module bare connections** — `MemoryTable.ensureConnection` registers a
   new `MemoryVirtualTableConnection` on first read/write
   (`packages/quereus/src/vtab/memory/table.ts:97-107`).
2. **Isolated covering connections** — `IsolatedTable.ensureConnection` registers
   a fresh `IsolatedConnection` on first read/write
   (`packages/quereus-isolation/src/isolated-table.ts:186-214`).
3. **Per-overlay memory connections** — when the overlay is created lazily *and*
   `savepointsBeforeOverlay` was empty (i.e. no prior `onConnectionSavepoint`
   fired because no IsolatedConnection existed at savepoint time),
   `overlay.update()` later causes the overlay's MemoryTable to auto-register a
   fresh `MemoryVirtualTableConnection` with no awareness of the active
   savepoint depth.

The existing `savepointsBeforeOverlay` workaround in
`IsolatedTable.ensureOverlay` (`isolated-table.ts:147-164`) only covers case 3
*when an IsolatedConnection was already registered at savepoint time* (so
`onConnectionSavepoint` populated the set). The general "savepoint before any
access" case slips through.

## Fix

Replay savepoints on register. In `Database.registerConnection`, after
`connection.begin()` succeeds and we know we're mid-transaction (and not in
deferred-constraint evaluation), iterate the `TransactionManager`'s active
savepoint stack and call `await connection.createSavepoint(i)` for each
`i ∈ [0, savepointStack.length)`. The new connection's stack then mirrors the
DB's, so every subsequent `releaseSavepoint(depth)` / `rollbackToSavepoint(depth)`
broadcast lands on a real entry.

Expose the savepoint depth via a small addition to `TransactionManager`
(e.g. `getActiveSavepointDepth(): number` returning `savepointStack.length`) so
`Database` doesn't need to know about the names. `createSavepoint(i)` only needs
the depth index — the connection-side savepoint protocol is name-free.

### Why this is the right layer

- One place, broad coverage: memory-bare, isolation, and any future module
  with lazy connection registration all benefit.
- It mirrors the existing semantics of `beginTransaction` broadcasting `begin()`
  to all connections — the savepoint stack is the same kind of transaction state
  that needs to be brought in sync.
- The `IsolatedTable.ensureOverlay` pre-alignment path (current
  `isolated-table.ts:147-164`) becomes a redundant belt-and-braces but doesn't
  conflict — `IsolatedConnection.createSavepoint` forwards to
  `tableCallback.onConnectionSavepoint` which is idempotent (Set.add). The
  existing isolation-layer regression tests in
  `quereus-isolation/test/isolation-layer.spec.ts` should keep passing.

### Failure mode in `IsolatedConnection`

When `registerConnection`-replay calls `IsolatedConnection.createSavepoint(d)`
on a connection where both `underlyingConnection` and `overlayConnection` are
`undefined` (the common case in `ensureConnection` when called before
`ensureOverlay`), the forwarded calls are no-ops, and only
`tableCallback.onConnectionSavepoint(d)` runs — which populates
`savepointsBeforeOverlay` so that the next `ensureOverlay()` creates a
pre-aligned overlay connection. Correct behavior, no extra code.

## Acceptance

- `Database.registerConnection` replays the active savepoint stack onto
  newly-registered connections (depth-only API, no name leakage).
- `TransactionManager` exposes the savepoint depth (or an equivalent
  `replaySavepointsOn(conn)` method) cleanly.
- Remove `'04-transactions.sqllogic'` from `MEMORY_ONLY_FILES` in
  `packages/quereus/test/logic.spec.ts`.
- Add a new sqllogic file (suggest `04a-savepoint-lazy-attach.sqllogic` next to
  `04-transactions.sqllogic`) covering at minimum:
  - **Case 1**: savepoint → first INSERT on a never-touched table → `ROLLBACK
    TO` undoes the insert.
  - **Case 2**: nested `SAVEPOINT outer; SAVEPOINT inner;` on a never-touched
    table → INSERT → `ROLLBACK TO outer` undoes the insert; `RELEASE outer`
    succeeds.
  - **Case 3**: prior write to base, BEGIN, `SAVEPOINT outer`, INSERT,
    `SAVEPOINT inner`, INSERT, `ROLLBACK TO inner` keeps `outer`-era write,
    `ROLLBACK TO outer` clears it but leaves committed base intact.
  - **Case 4** (isolation-specific): same as Case 1 but with explicit
    `BEGIN; SELECT ...; SAVEPOINT sp; INSERT ...; ROLLBACK TO sp;` — i.e. read
    happened before savepoint so the IsolatedConnection exists but the overlay
    does not. Verifies the pre-existing `savepointsBeforeOverlay` path stays
    correct.
- Add a parallel unit test in
  `packages/quereus-isolation/test/isolation-layer.spec.ts` for Case 1 using
  the existing IsolationModule + MemoryTable harness.
- Both `yarn test` and `yarn test:store` green.

## TODO

- [ ] Add `TransactionManager.getActiveSavepointDepth()` (or `forEachSavepoint`)
      in `database-transaction.ts`.
- [ ] In `Database.registerConnection` (`database.ts:1436-1454`), after the
      successful `connection.begin()` branch, replay savepoint stack onto the
      new connection. Handle errors symmetrically to the `begin()` path
      (log and continue, do not throw — connection registration must not fail
      mid-transaction).
- [ ] Remove `'04-transactions.sqllogic'` from `MEMORY_ONLY_FILES` in
      `logic.spec.ts:39-48`.
- [ ] Add `packages/quereus/test/logic/04a-savepoint-lazy-attach.sqllogic`
      with cases 1–4 above.
- [ ] Add a focused regression test in
      `packages/quereus-isolation/test/isolation-layer.spec.ts` covering
      Case 1.
- [ ] Confirm `quereus-isolation/test/isolation-layer.spec.ts` "savepoint
      before overlay" tests added by the prereq ticket still pass —
      the existing `savepointsBeforeOverlay` pre-alignment path remains
      live as a secondary guard and must not double-push.
- [ ] Run `yarn test` and `yarn test:store`. Both green.
