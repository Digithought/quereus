---
description: Decomposed sync-manager-impl.ts (1,676 → ~550 lines) into focused modules
dependencies: none
---

# Sync Manager Decomposition — Review

## Summary

Decomposed `packages/quereus-sync/src/sync/sync-manager-impl.ts` from a 1,676-line monolith into a coordinator/facade (~550 lines) that delegates to three focused modules:

## New Files

### `sync-context.ts` — Shared context interface
- `SyncContext` interface providing all stores/config needed by sub-modules
- `persistHLCState()` / `persistHLCStateBatch()` — shared HLC persistence (fixes DRY violation)
- `SyncManagerImpl` implements `SyncContext`

### `snapshot-stream.ts` — Streaming snapshot operations (~340 lines)
- `getSnapshotStream()` — stream snapshot chunks
- `resumeSnapshotStream()` — resume from checkpoint
- `applySnapshotStream()` — consume streaming snapshot with progress/checkpoints
- `getSnapshotCheckpoint()` — retrieve saved checkpoint
- Internal: `streamSnapshotChunks()` shared generator (fixes DRY: unified getSnapshotStream/resumeSnapshotStream)

### `change-applicator.ts` — Change application logic (~270 lines)
- `applyChanges()` — 3-phase change application
- `resolveChange()` — CRDT conflict resolution (phase 1)
- `commitChangeMetadata()` — persist CRDT metadata (phase 3)
- `ResolvedChange` interface

### `snapshot.ts` — Non-streaming snapshots (~210 lines)
- `getSnapshot()` — full in-memory snapshot
- `applySnapshot()` — apply full snapshot (replace all data)

## DRY Violations Fixed

1. **HLC serialization** (3 locations → 2 shared functions): `persistHLCState()` and `persistHLCStateBatch()` in sync-context.ts replace inline serialization in handleDataChange/handleSchemaChange.
2. **Snapshot streaming duplication** (~130 lines × 2 → 1 shared generator): `getSnapshotStream` and `resumeSnapshotStream` now both delegate to `streamSnapshotChunks()` with parameterized differences.
3. **GetTableSchemaCallback** type duplication remains (sync-manager-impl.ts vs create-sync-module.ts) — deferred to separate task.

## What Stayed in SyncManagerImpl

- Constructor and `create()` factory
- `handleDataChange()` / `handleSchemaChange()` event handlers
- `recordColumnVersions()` helper
- `getChangesSince()` / `collectAllChanges()` delta sync
- `canDeltaSync()`, `updatePeerSyncState()`, `getPeerSyncState()`, `pruneTombstones()`, `getEventEmitter()`
- Thin delegation methods for all extracted functionality

## Testing & Validation

- All 143 existing tests pass (mocha: `yarn workspace @quereus/sync test`)
- Full build passes (`yarn build`) with no TypeScript errors
- No public API changes — `SyncManager` interface and `SyncManagerImpl` class unchanged
- `index.ts` barrel exports unchanged

## Key Files

- `packages/quereus-sync/src/sync/sync-manager-impl.ts` — refactored facade
- `packages/quereus-sync/src/sync/sync-context.ts` — shared context + HLC helpers
- `packages/quereus-sync/src/sync/snapshot-stream.ts` — streaming snapshot module
- `packages/quereus-sync/src/sync/change-applicator.ts` — change application module
- `packages/quereus-sync/src/sync/snapshot.ts` — non-streaming snapshot module
- `packages/quereus-sync/test/sync/sync-manager.spec.ts` — unit tests
- `packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts` — e2e tests
