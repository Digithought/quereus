---
description: Error handling gaps in sync-manager-impl.ts (silent failures, unhandled async, missing error boundaries)
dependencies: none

---

# Error Handling Gaps in SyncManager

## 1. Silent Failure on Missing Primary Key

**File:** `packages/quereus-sync/src/sync/sync-manager-impl.ts` lines 201-205

`handleDataChange()` silently returns when `pk` is missing. No log, no warning, no metric. Data changes are silently lost from the CRDT perspective.

**Fix:** Add a `console.warn` (or structured logging) when pk is missing, since this indicates either a store bug or an unsupported table shape.

## 2. Unhandled Errors in Async Event Handlers

**File:** `packages/quereus-sync/src/sync/sync-manager-impl.ts` lines 194, 259

`handleDataChange` and `handleSchemaChange` are async methods bound as event handlers (via `storeEvents.onDataChange(...)` during `create()`). If they throw, the error is an unhandled promise rejection since event emitters don't `await` the callback.

**Fix:** Wrap the body of both handlers in try/catch, logging the error and optionally emitting an error sync state event.

## 3. No Error Handling for applyToStore Callback Failure

**File:** `packages/quereus-sync/src/sync/sync-manager-impl.ts` line 639

In `applyChanges()`, the `applyToStore` callback is called after resolving all changes but before committing CRDT metadata. If the callback throws, the two-phase apply is left in an inconsistent state — changes are resolved but metadata is not committed, and the data store may have partially applied changes.

**Fix:** Wrap the `applyToStore` call in try/catch. On failure, the method should still commit CRDT metadata (since the changes are resolved) or provide clear rollback semantics.

## 4. Inconsistent Conflict Event Emission

**File:** `packages/quereus-sync/src/sync/sync-manager-impl.ts` line 769

The `ConflictEvent` is only emitted when the local value wins the LWW conflict. When the remote value wins, no conflict event is emitted. This makes the `onConflictResolved` event unreliable for tracking all conflicts.

**Fix:** Emit a conflict event in both cases (local-wins and remote-wins), using the `winner` field to distinguish.

## 5. console.warn for Missing Table Schema

**File:** `packages/quereus-sync/src/sync/sync-manager-impl.ts` line 328

Uses `console.warn` for operational logging (`[Sync] No table schema found`). This is noisy in test output and not controllable.

**Fix:** Either accept a logger in config, or make this a debug-level log, or suppress when a getTableSchema callback is not provided (expected behavior).

