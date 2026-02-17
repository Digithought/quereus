---
description: DRY violations in sync-manager-impl.ts (HLC serialization, snapshot streaming duplication, type duplication)
dependencies: none
priority: 3
---

# DRY Violations in sync-manager-impl.ts

## 1. Duplicated HLC Serialization

Identical HLC persistence code appears three times:

- `handleDataChange()` lines 234-239 — inline HLC serialization into batch
- `handleSchemaChange()` lines 298-303 — inline HLC serialization with direct `kv.put()`
- `persistHLCState()` lines 380-387 — dedicated method that does the same thing

The first two should call `persistHLCState()`. For `handleDataChange`, the method would need a batch-aware variant since it writes into an existing batch.

**Fix:** Add a `persistHLCStateBatch(batch)` method and use it in `handleDataChange`. Use the existing `persistHLCState()` in `handleSchemaChange`.

**Files:** `packages/quereus-sync/src/sync/sync-manager-impl.ts`

## 2. getSnapshotStream / resumeSnapshotStream Duplication

`getSnapshotStream()` (lines 1152-1283) and `resumeSnapshotStream()` (lines 1536-1674) are ~130 lines each and nearly identical. The only differences:
- `resumeSnapshotStream` skips tables in `checkpoint.completedTables`
- `resumeSnapshotStream` uses checkpoint's siteId/hlc instead of current
- `resumeSnapshotStream` initializes `totalEntries` from checkpoint

**Fix:** Extract a shared `*streamSnapshotTables(options)` generator that both methods delegate to, parameterized by the skip set, identity, and initial entry count.

**Files:** `packages/quereus-sync/src/sync/sync-manager-impl.ts`

## 3. Duplicated GetTableSchemaCallback Type

`GetTableSchemaCallback` is defined in two places:
- `packages/quereus-sync/src/create-sync-module.ts` line 19
- `packages/quereus-sync/src/sync/sync-manager-impl.ts` line 14

**Fix:** Keep one definition (in `create-sync-module.ts` since it's the public API) and import from the other location.

**Files:** `packages/quereus-sync/src/create-sync-module.ts`, `packages/quereus-sync/src/sync/sync-manager-impl.ts`

