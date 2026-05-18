---
description: Review the DML statement-scope savepoint broadcast + lazy memory-connection snapshot pair (`dml-executor.ts` + `vtab/memory/layer/connection.ts`). Both changes land together — the broadcast alone causes a halloween-problem regression in self-referential INSERT...SELECT; the lazy snapshot alone leaves the 95-assertions:202 mismatch in place. All 3175 quereus tests and 68 isolation tests pass.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/vtab/memory/layer/connection.ts
---

# Review handoff — DML statement-scope savepoint broadcast

## What landed

### A. `packages/quereus/src/runtime/emit/dml-executor.ts`

Two related changes inside `emitDmlExecutor`:

1. **Module-scope counter** (`stmtSavepointCounter`, just above the
   `RuntimeUpsertClause` interface). Module-scope is required so nested
   concurrent emissions (e.g. FK cascade INSERT inside a parent INSERT)
   produce unique savepoint names within the same
   TransactionManager savepoint stack — a function-local counter would
   reset to 0 in the inner runInsert and collide on `__or_abort_0`.

2. **Statement-scope savepoint wrap in `runInsert`** for non-FAIL modes
   (default ABORT / IGNORE / REPLACE / ROLLBACK). When
   `plan.onConflict !== FAIL`, the function now:
   - calls `ctx.db._createSavepoint('__or_abort_N')` and broadcasts
     `connection.createSavepoint(depth)` to every connection in
     `ctx.db.getAllConnections()` before iterating rows;
   - on successful completion of the row loop, broadcasts
     `_releaseSavepoint` / `connection.releaseSavepoint(depth)`;
   - on exception from inside the loop, broadcasts a `_rollbackToSavepoint`
     + `_releaseSavepoint` pair (each in its own try/catch that swallows —
     mirrors `transaction.ts`'s defensive structure), then re-throws.

   The wrap is added by introducing a second `try { try { ... } catch { ... } } finally { ... }`
   inside the existing `try { for await ... } finally { disconnect }`.
   The existing FAIL-mode per-row `__or_fail_N` savepoint stays nested
   unchanged.

### B. `packages/quereus/src/vtab/memory/layer/connection.ts`

The broadcast above exposed a halloween-problem regression: at the
start of an `INSERT ... SELECT FROM same_table`, the statement
savepoint's `createSavepoint(0)` previously eagerly created a
`pendingTransactionLayer`. The subsequent SELECT
(`MemoryTable.query()` line 231 selects `conn.pendingTransactionLayer ?? conn.readLayer`)
then iterated the pending layer, and `processInsertRow`'s writes
landed in the same layer the iterator was walking, doubling output
49–50× until `Number.isSafeInteger` rejected the runaway value.

Fix: **lazy-snapshot** behavior in `MemoryTableConnection`.

- `savepointStack` is now `Array<TransactionLayer | null>`.
- `createSavepoint(depth)` no longer auto-creates a pending layer; if
  none exists, it pushes `null` onto the stack as a "no-pending-at-create"
  marker.
- `rollbackToSavepoint(targetDepth)`: when the stack entry is `null`,
  restores `pendingTransactionLayer = null`. The `if (!pendingTransactionLayer) return`
  guard at the top is gone — the rollback must still truncate the
  savepoint stack to `targetDepth + 1` even on idle connections.
- `releaseSavepoint(targetDepth)`: also drops its early-out guard, so a
  stmt-savepoint release that fires on a connection with no pending
  layer still pops its placeholder. (Without this drop, a release on
  an idle connection would leave the placeholder, and a subsequent
  user-level `SAVEPOINT` would push to the wrong index.)

## Why both changes are required together

- **Broadcast alone** → bug B regresses `01.5-insert-select.sqllogic`
  (self-referential INSERT...SELECT iterating its own writes).
- **Lazy-snapshot alone** → bug A still fails on
  `95-assertions.sqllogic:202` (release isn't broadcast, so the
  registerConnection-replay placeholder stays at depth 0 and a later
  user SAVEPOINT lands at depth 1, leaving the empty placeholder for
  ROLLBACK TO).

Both must be present for both target tests to pass.

## Validation actually run

| command | result |
|---------|--------|
| `yarn workspace @quereus/quereus run build` | clean (exit 0) |
| `node packages/quereus/test-runner.mjs --reporter=spec -g "95-assertions\|01.5-insert-select"` | both pass |
| `yarn workspace @quereus/quereus run test` | **3175 passing** (full quereus suite) |
| `yarn workspace @quereus/isolation run test` | **68 passing** |

The pre-existing `IsolationModule … DROP INDEX inside an active
transaction` failure the prior fix-stage notes called out on `fd` did
not reproduce here — the 68 isolation tests all passed. Worth a quick
look from the reviewer to confirm this was either fixed incidentally
(plausible: the lazy-snapshot change affects savepoint behavior) or
was test-config-dependent.

## Use cases the reviewer should re-check by hand

The two target tests are the floor, not the ceiling. Suggested manual
spot-checks (all currently passing in the full suite, but worth eyes
on):

- **SAVEPOINT ordering parity with TxnMgr**: any test that mixes an
  implicit INSERT (no OR clause) with a user-issued `SAVEPOINT … ROLLBACK TO sp`
  pattern. The `95-assertions.sqllogic` block at line ~202 is the
  canonical case; any similar block in
  `test/logic/14-savepoints.sqllogic`, `15-transactions*.sqllogic`,
  `52-or-conflict-clause.sqllogic` is also exercised.
- **Self-referential INSERT...SELECT**:
  `test/logic/01.5-insert-select.sqllogic` test #7 is the canonical
  case for the halloween-problem regression that lazy-snapshot fixes.
  Other patterns worth eyeballing: recursive CTE-driven inserts that
  read and write the same vtab in one statement.
- **UPSERT (`ON CONFLICT DO UPDATE`)** still goes through the new
  statement savepoint wrap (it's non-FAIL). Confirm the
  `test/logic/53-upsert.sqllogic` block still behaves as before — the
  rollback path on a mid-UPSERT constraint failure now broadcasts to
  connections, where previously it didn't.
- **FK cascade inside a parent INSERT** exercises the module-scope
  counter. Without it, a cascade's nested `runInsert` would mint
  `__or_abort_0` while the parent still holds `__or_abort_0`, and
  `_createSavepoint` would reject the duplicate. Tests in
  `test/logic/54-foreign-keys.sqllogic` cover this.

## Known gaps / out-of-scope follow-ups

1. **`runUpdate` and `runDelete` did not get the same wrap.** If a
   multi-row UPDATE with an ABORT-class conflict ever needs to unwind
   partial writes when the vtab can't already snapshot, that's a
   future ticket. No failing test currently surfaces this; flagging
   because the asymmetry with `runInsert` is the kind of thing a
   reviewer should notice and decide on rather than be surprised by.

2. **FAIL mode still doesn't broadcast.** The existing
   `__or_fail_N` per-row savepoints in `runInsert` go through
   `ctx.db._createSavepoint` / `_releaseSavepoint` / `_rollbackToSavepoint`
   but never call `connection.createSavepoint(depth)` etc. Per the
   implement ticket, this is left "nested unchanged". In theory the
   same registerConnection-replay scenario that bit bug A could bite
   FAIL mode if a brand-new connection registers during the FAIL row
   loop — but the per-row scope is so tight that no test exercises it.
   If FAIL ever starts misbehaving around concurrent connection
   registration, this is the first place to look.

3. **`createTransactionSnapshot`** still exists and is invoked
   whenever a non-empty pending layer is snapshotted by the new
   broadcast. The lazy-snapshot fix avoids the eager-creation case
   only — once the user mutates and the pending layer exists, every
   subsequent savepoint still pays the snapshot cost (copying all
   rows of the pending layer into an immutable snapshot). If the
   statement-savepoint wrap proves expensive for large INSERT...SELECT
   when the pending layer is already populated by prior statements in
   the same transaction, the next move would be COW-style sharing in
   `createTransactionSnapshot` — but that's a perf concern, not a
   correctness one, and out of scope here.

4. **`memory-connection.ts` `registerConnection` replay** (the
   mechanism that surfaced bug A) was not modified. The bug was at
   the consumer side: replay correctly pushed the connection state up
   to depth N, but the missing broadcast on release left it stuck
   there. Lazy-snapshot now also makes the replay cheaper for idle
   connections (they push `null` instead of allocating a layer).
   Worth a reviewer's eye on whether replay should itself pass `null`
   markers when the connection is genuinely idle — currently it goes
   through `createSavepoint(depth)` which lazy-snapshots correctly,
   so behavior is right, but the chain is one hop longer than it
   needs to be.

## Files touched

- `packages/quereus/src/runtime/emit/dml-executor.ts` — added module-
  scope `stmtSavepointCounter` and the statement-savepoint wrap in
  `runInsert`.
- `packages/quereus/src/vtab/memory/layer/connection.ts` — savepoint
  stack now nullable, lazy-snapshot in `createSavepoint`, matching
  branches in `rollbackToSavepoint` and `releaseSavepoint`.
