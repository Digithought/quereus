---
description: Fix O(n) full scans and DRY violations in isolation layer
dependencies: packages/quereus-isolation/src/isolated-table.ts
files:
  - packages/quereus-isolation/src/isolated-table.ts
---

# Isolation Layer Performance and DRY Fixes

## What was built

### O(n) → O(log n) Performance Fixes

- **`getOverlayRow()`**: Replaced full scan (`createFullScanFilterInfo()`) with `buildPKPointLookupFilter(pk)` — a FilterInfo that produces an equality seek on the PK index (`idx=_primary_(0);plan=2`). Now O(log n).

- **`rowExistsInUnderlying()`**: Same fix — uses PK point lookup instead of full table scan. This was the most impactful because it's called per overlay entry during commit flush.

- **`clearOverlay()`**: Replaced O(n) iterate-all-rows + delete-one-by-one with a simple `clearConnectionOverlay()` call that discards the overlay reference entirely. The overlay table is ephemeral and per-connection, so GC reclaims it. Next write lazily creates a fresh one via `ensureOverlay()`. Changed from async to sync.

### New helper: `buildPKPointLookupFilter(pk)`

Constructs a FilterInfo for PK equality seek, matching the format the MemoryTable scan layer expects (`idxStr: 'idx=_primary_(0);plan=2'` with properly structured constraints and args). Works for both single-column and composite primary keys.

### DRY Fixes

- **Commit paths unified**: Extracted `flushAndClearOverlay()` shared by both `commit()` and `onConnectionCommit()`.

- **Rollback paths**: Both now call the simplified sync `clearOverlay()` directly.

- **Savepoint dual-path risk fixed**: Table-level `savepoint()`/`release()`/`rollbackTo()` no longer forward to the overlay — only to the underlying table. The overlay's savepoints are managed by `IsolatedConnection` which delegates to the overlay's own registered connection. This eliminates the risk of double-savepointing that would corrupt the savepoint stack.

## Testing notes

- All 60 isolation layer tests pass
- All tests across the full monorepo pass (121 total in sync-coordinator, etc.)
- Build succeeds
- Existing tests cover: CRUD, composite PKs, savepoints (including nested rollback), secondary index scans, commit/rollback, autocommit, delete-then-reinsert, sequential transactions

## Key files

- `packages/quereus-isolation/src/isolated-table.ts` — all changes
