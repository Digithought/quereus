description: Enabling IsolationModule in the logic-test store harness reveals widespread pre-existing isolation-layer bugs — core scenarios work but many unrelated logic tests fail through the overlay+merge path
prereq: none
files:
  packages/quereus/test/logic.spec.ts
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
----

## Status

Core work from the original ticket is **done** and verified. The blocking question is how to proceed given that enabling isolation exposes many pre-existing isolation-layer bugs that fall outside this ticket's intended scope.

## What was done

### Core wiring (ticket TODO)

- `packages/quereus/test/logic.spec.ts:448` — swapped `new StoreModule(provider)` for `createIsolatedStoreModule({ provider })`. The store logic test harness now exercises the isolation layer.

- Teardown wrapper: added a pass-through `closeAll()` method to `IsolationModule` (`packages/quereus-isolation/src/isolation-module.ts:237`) that delegates to the underlying module's `closeAll` if present, plus a try/catch in the `afterEach` hook to tolerate transient LevelDB lock contention during cleanup on Windows.

### Isolation-layer fixes required to make the core scenarios pass

- **`StoreTable.begin/commit/rollback`** (`packages/quereus-store/src/common/store-table.ts:724`) — the isolation layer's `flushOverlayToUnderlying` calls these as an independent mini-transaction on the underlying table. `StoreTable` previously only exposed connection-level transactions via `StoreConnection`; without table-level methods, writes buffered by the coordinator during flush were never committed to the KV store, so autocommit INSERTs weren't persisted.

- **`IsolationModule.connect` honours `_readCommitted`** (`packages/quereus-isolation/src/isolation-module.ts:211-232`) — when the planner requests a committed-snapshot read (via the `committed.*` pseudo-schema), `IsolatedTable` now bypasses the overlay and delegates straight to the underlying table. Without this, `SELECT FROM committed.foo` inside a transaction still merged the overlay and saw staged writes.

- **`IsolatedTable` readCommitted flag** (`packages/quereus-isolation/src/isolated-table.ts:30-54,204-216`) — new constructor parameter that, when true, routes `query()` directly to the underlying table, skipping the merge path.

### New unit tests (ticket TODO)

In `packages/quereus-store/test/isolated-store.spec.ts`:

- **UPDATE read-your-own-writes within a transaction** — BEGIN, UPDATE, in-transaction SELECT sees the new value, `committed.*` sees the pre-transaction value, ROLLBACK restores underlying. Passing.

- **Failed-commit rollback** — a `CREATE ASSERTION` that guards `balance >= 0` rejects a COMMIT whose staged UPDATE would violate it; the underlying row retains its pre-transaction value. Passing (validates scenario B end-to-end: deferred-constraint rejection → `connection.rollback()` → overlay discard → underlying KV unchanged).

## Verification (positive results)

- `yarn test` — memory mode: **2443 passing**, all green.
- `yarn test` in `packages/quereus-store` — **183 passing**, including the new UPDATE/failed-commit tests.
- `yarn test:store` on ticket target files:
  - `42-committed-snapshot.sqllogic` — **passes** (scenario A, full).
  - `95-assertions.sqllogic` — **passes** (scenario C, multi-assertion ordering).
- Overall store-mode suite progresses from baseline **502 passing** → **562 passing** (+60 tests) with my changes, because numerous files that were implicitly broken by non-isolated store semantics now work.

## The blocker

Running the full store suite after enabling isolation surfaces a steady stream of failures in *unrelated* logic tests. Each one is a distinct pre-existing isolation-layer bug. I iterated through ~15 exclusions chasing the "next" failing test; each exclusion revealed another. This is no longer matching the ticket's intent ("narrow the exclusion with a comment rather than restoring the blanket skip") — we'd be excluding roughly half the suite.

Categorised bugs surfaced (each is its own follow-on ticket):

### Cross-layer UNIQUE / ON CONFLICT enforcement

`IsolatedTable.update` (`packages/quereus-isolation/src/isolated-table.ts:589-654`) checks only the overlay for duplicate PKs and relies on `overlay.update` for UNIQUE enforcement. The overlay doesn't know about underlying rows, so duplicate PKs that exist only in the underlying slip through.

Affected files:
- `04-transactions.sqllogic` (duplicate-PK rollback semantics in implicit txn batch)
- `102-unique-constraints.sqllogic` (non-PK UNIQUE column)
- `47-upsert.sqllogic` (ON CONFLICT DO NOTHING / REPLACE)

### Deferred constraint ambiguity with overlay connection

Both the `IsolatedConnection` and the overlay's `MemoryVirtualTableConnection` register against the same table name. `DeferredConstraintQueue.findConnection` (`packages/quereus/src/runtime/deferred-constraint-queue.ts:154`) throws "multiple candidate connections for table main.X".

Affected:
- `40-constraints.sqllogic`
- `41-foreign-keys.sqllogic`

### DROP + re-CREATE race in `IsolationModule.destroy` path

Destroying a table through the isolation wrapper and immediately re-creating it with the same name fails — the underlying `StoreModule.tables` map still contains the old entry when `create` runs. Needs investigation; initial tracing showed `StoreModule.destroy` completes its map delete *after* the next `create` has already checked the map.

Affected:
- `10.1-ddl-lifecycle.sqllogic` (CREATE/DROP reuse section)
- `102-schema-catalog-edge-cases.sqllogic`

### Savepoint rollback through overlay hits undefined schema

`IsolatedConnection.rollbackToSavepoint` → `MemoryVirtualTableConnection.rollbackToSavepoint` → `TransactionLayer` constructor with undefined schema (`packages/quereus/src/vtab/memory/layer/transaction.js:29`). The overlay was likely never properly begun at the savepoint that's being rolled back to.

Affected:
- `101-transaction-edge-cases.sqllogic`

### ALTER TABLE / COLUMN through isolation loses data

Overlay schema is rebuilt on ALTER; pending writes get dropped. RENAME doesn't propagate to the overlay's schema copy.

Affected:
- `41-alter-table.sqllogic`
- `41.2-alter-column.sqllogic`

### FK CASCADE DELETE via overlay does not cascade

Multi-row CASCADE DELETE through isolation leaves child rows behind.

Affected:
- `29-constraint-edge-cases.sqllogic`
- `43-transition-constraints.sqllogic`

### PK DESC iteration order not preserved by the merge

Merge merges by natural key order; overlay and underlying use different index collations for DESC PKs.

Affected:
- `40.1-pk-desc-direction.sqllogic`

### UPDATE with PK change leaves old PK row in overlay

Changing the PK value in an UPDATE inserts a new overlay row but does not tombstone the old one.

Affected:
- `41-fk-cross-schema.sqllogic`

### RETURNING / DELETE-as-subquery not observing overlay

DELETE … RETURNING and composite DML that reads back its own writes doesn't see overlay rows.

Affected:
- `42-returning.sqllogic`
- `44-orthogonality.sqllogic`
- `49-reference-graph.sqllogic`

### Pre-existing store limitation (not isolation)

- `41.1-alter-pk.sqllogic` — Store module does not support in-place PK alteration (previously filed as `store-alter-primary-key-unsupported`).

## Questions for the next agent / human

1. **Preferred path forward?**
   - **Option A — Fix the underlying isolation-layer bugs first.** Break out each category above into its own ticket and work them sequentially. Once the isolation layer is solid, come back and drop the exclusions. The logic suite then meaningfully exercises isolation. High total effort but correct architecture.
   - **Option B — Accept wide exclusions.** Merge the current state (isolation enabled, ~15 files excluded with per-bug comments). Core scenarios A/B/C are verified in `isolated-store.spec.ts` unit tests. Follow-on tickets filed for each category. Ships today; the logic suite covers less of the isolation surface.
   - **Option C — Keep isolation out of the logic harness.** Revert `logic.spec.ts` to `new StoreModule(provider)`. Keep the unit-test additions, `StoreTable.begin/commit/rollback`, the `_readCommitted` routing, and `IsolationModule.closeAll` — all independently useful. Isolation semantics remain verified by the dedicated unit tests but aren't stressed by the logic suite until the underlying bugs are fixed. This is what the ticket's "narrow the exclusion with a comment" arguably resolves to if "narrow" would be more than a handful of files.

2. **If Option B:** is the current exclusion list (see `MEMORY_ONLY_FILES` on the working branch — 13 new entries) acceptable, or should some of these be split/combined differently? Each is documented with the root cause.

3. **If Option A:** which category should be the first follow-on ticket? The cross-layer UNIQUE bug is the most pervasive and blocks the most tests; the deferred-constraint-ambiguity bug is probably the simplest (pick the isolated connection and ignore the overlay's registered connection for the deferred-row check).

## Current working-tree state

All the code changes above are in the working tree (unstaged). Nothing has been committed. The runner should either resume the ticket (if unblocked) or stash/reset if a different direction is chosen.

- `packages/quereus-isolation/src/isolation-module.ts` — `underlying` made public readonly, `closeAll()` added, `_readCommitted` plumbed through `connect`.
- `packages/quereus-isolation/src/isolated-table.ts` — `readCommitted` constructor arg; `query()` fast-paths to underlying when true.
- `packages/quereus-store/src/common/store-table.ts` — `begin/commit/rollback` at table level.
- `packages/quereus-store/test/isolated-store.spec.ts` — UPDATE-read-your-own-writes test; failed-commit-rollback test.
- `packages/quereus/test/logic.spec.ts` — `createIsolatedStoreModule` wiring; try/catch around teardown; expanded `MEMORY_ONLY_FILES` with per-bug comments.

## Recommendation

Option A. The isolation layer is the correct long-term home for these semantics, and shipping Option B permanently disables a lot of coverage. The first follow-on ticket should be the deferred-constraint-ambiguity fix (cheap, high-value: unblocks 40, 41 foreign keys, probably others).
