---
description: Error handling improvements in sync-manager-impl.ts and change-applicator.ts
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/test/sync/sync-manager.spec.ts
---

# SyncManager Error Handling — Review

## Changes Made

### 1. Warning on Missing Primary Key (sync-manager-impl.ts)
`handleDataChange()` now logs `console.warn` when `pk` is missing instead of silently returning. This makes it visible when data changes are lost from CRDT tracking due to missing keys.

### 2. Try/Catch on Async Event Handlers (sync-manager-impl.ts)
Both `handleDataChange` and `handleSchemaChange` are wrapped in try/catch. On error, they:
- Log via `console.error`
- Emit a `SyncState` error event so UI can react
- Do NOT re-throw (these are fire-and-forget event handlers — re-throwing would cause unhandled promise rejections)

### 3. Error Handling for applyToStore Failure (change-applicator.ts)
The `applyToStore` callback in phase 2 of `applyChanges()` is wrapped in try/catch. On failure:
- Emits `SyncState` error event
- Re-throws so the caller can retry
- CRDT metadata is intentionally NOT committed, allowing the same changes to be re-resolved on the next sync attempt

### 4. Consistent Conflict Event Emission (change-applicator.ts)
`ConflictEvent` is now emitted when the remote value wins LWW (in addition to the existing local-wins case). The `winner` field distinguishes the cases. This makes `onConflictResolved` reliable for tracking all conflicts.

### 5. Conditional Table Schema Warning (sync-manager-impl.ts)
The `console.warn` for missing table schema now only fires when `getTableSchema` callback was provided but returned undefined. When no callback is provided, fallback column names are expected behavior and no warning is emitted.

## Testing
8 new tests added to `sync-manager.spec.ts` in the `error handling` describe block:
- Missing PK warning
- handleDataChange error → error state emission
- handleSchemaChange error → error state emission
- applyToStore failure → error state + rethrow
- Remote-wins conflict event emission
- Both local-wins and remote-wins conflict events
- No table schema warning suppressed without callback
- Table schema warning present with callback returning undefined

All 151 tests pass.
