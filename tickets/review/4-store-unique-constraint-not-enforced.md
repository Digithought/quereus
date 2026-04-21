description: Enforce non-PK UNIQUE constraints in StoreTable's INSERT and UPDATE paths.
dependencies: none
files:
  packages/quereus-store/src/common/store-table.ts (modified — added checkUniqueConstraints / findUniqueConflict / deleteRowAt / uniqueColumnsChanged; wired into all three insert/update branches)
  packages/quereus-store/src/common/transaction.ts (modified — added getPendingOpsForStore so unique checks see intra-transaction writes)
  packages/quereus-store/test/unique-constraints.spec.ts (new spec)
  packages/quereus/test/logic.spec.ts (updated exclusion comment for 102-unique-constraints)
----

## What changed

Previously `StoreTable.update` only checked primary-key collision. `tableSchema.uniqueConstraints` was never consulted, so duplicate non-PK UNIQUE values were silently accepted (e.g. `INSERT INTO t_uc VALUES (3, 'alice@test.com', 'Eve')` when alice already existed).

This change adds a `checkUniqueConstraints` private helper on `StoreTable` and calls it from:

- INSERT — after the PK collision branch.
- UPDATE same-PK — only when `uniqueColumnsChanged()` reports that constrained columns actually differ between old and new (avoids self-conflicts).
- UPDATE PK-change — also runs an INSERT-style PK check at the new key, then the UNIQUE check; both old and new PKs are skipped from conflict candidates so a relocation doesn't false-conflict against the row being moved.

Conflict resolution is honored consistently with the existing PK path:
- `IGNORE` returns `{status:'ok', row:undefined}` with no mutation or events.
- `REPLACE` deletes the conflicting row (data + secondary indexes + delete event + stats) via `deleteRowAt`, then continues.
- Default returns `{status:'constraint', constraint:'unique', message, existingRow}`.

NULL semantics follow SQL standard / memory-mode: a constraint is skipped if any covered column in the new row is NULL.

The check uses Option A (full primary-data scan) per the ticket; auto-creating backing index stores was deemed unnecessary given table sizes in the affected tests.

## Transaction-pending writes

`TransactionCoordinator.getPendingOpsForStore(store?)` returns a last-write-wins snapshot of buffered ops targeting the given store, keyed by hex-encoded key. `findUniqueConflict` overlays committed iteration with that snapshot so duplicates inserted earlier in the same transaction are detected before commit, and rows pending-deleted in the transaction are not falsely flagged.

## Isolation-layer note

The `102-unique-constraints.sqllogic` regression remains in the store-mode exclusion list (`packages/quereus/test/logic.spec.ts:60`), but the comment is now scoped accurately:

> INSERT OR REPLACE conflict resolution does not flow across isolation overlay; underlying StoreTable enforces UNIQUE correctly (see store-table unique.spec.ts)

The basic-rejection scenarios pass through the isolation layer once StoreTable enforces UNIQUE; only the REPLACE-through-overlay path remains broken because `IsolatedTable.flushOverlayToUnderlying` calls `underlyingTable.update({operation:'insert'})` without forwarding `onConflict`. That's a follow-up isolation-layer ticket, not a StoreTable issue.

## Validation

Cases to confirm in review (new `packages/quereus-store/test/unique-constraints.spec.ts` covers each):

- single-column UNIQUE: rejects duplicate INSERT, IGNORE silently skips, REPLACE evicts the conflicting row and inserts the new one.
- NULL semantics: multiple NULLs allowed in the same UNIQUE column; non-NULL duplicates still rejected.
- UPDATE same-PK: rejects update to a conflicting value; allows update to own value (no self-conflict); allows update to a fresh value; updating a non-UNIQUE column skips the check.
- composite UNIQUE on `(a, b)`: rejects duplicate combinations; partial overlap allowed.
- PK-change UPDATE: rejects when the new value collides on UNIQUE; allows clean PK changes; old row preserved on rejection.

Test runs:

- `packages/quereus-store` — 193 passing (5 new specs added).
- `yarn workspace @quereus/quereus test` (memory mode) — 2443 passing, no regressions.
- `QUEREUS_TEST_STORE=true yarn workspace @quereus/quereus test` — 562 passing, 1 failure (`49-reference-graph.sqllogic`, pre-existing, unrelated; confirmed identical to baseline).
- `yarn workspace @quereus/quereus lint` — 0 errors. (`@quereus/store` has no lint script per AGENTS.md.)

## Reviewer focus

- `findUniqueConflict` overlay loop in `store-table.ts`: confirm the seen-set logic correctly avoids double-yielding pending puts that override committed entries, and yields pending-only puts whose key wasn't in the committed scan.
- `selfPks: SqlValue[][]` for PK-change UPDATE: confirm passing both `[oldPk, newPk]` is right — old PK is being deleted, new PK identifies the relocated row.
- `getPendingOpsForStore` is generic over target store; passing `undefined` matches the coordinator's default store. Used here only against the data store.
- `bytesToHex` duplicates the helper inside `memory-store.ts` and `transaction.ts`. Small enough to keep file-local, but could be promoted to a shared util later.
- Same-PK UPDATE skips the UNIQUE check entirely when no constrained columns changed (`uniqueColumnsChanged`). This is an optimization, but if `oldRow` is `null` (target row missing) we conservatively still run the check — that path is unreachable through normal SQL UPDATE but cheap to keep correct.
