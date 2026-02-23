---
description: DRY violations in sync-manager-impl.ts — remaining: GetTableSchemaCallback type duplication
dependencies: none

---

# DRY Violations in sync-manager-impl.ts

## ~~1. Duplicated HLC Serialization~~ — RESOLVED

Fixed in sync-manager-decomposition task. `persistHLCState()` and `persistHLCStateBatch()` in `sync-context.ts` replace all inline HLC serialization.

## ~~2. getSnapshotStream / resumeSnapshotStream Duplication~~ — RESOLVED

Fixed in sync-manager-decomposition task. Both now delegate to `streamSnapshotChunks()` in `snapshot-stream.ts`.

## 3. Duplicated GetTableSchemaCallback Type

`GetTableSchemaCallback` is defined in two places:
- `packages/quereus-sync/src/create-sync-module.ts` line 19
- `packages/quereus-sync/src/sync/sync-manager-impl.ts` line 15

**Fix:** Keep one definition (in `create-sync-module.ts` since it's the public API) and import from the other location.

**Files:** `packages/quereus-sync/src/create-sync-module.ts`, `packages/quereus-sync/src/sync/sync-manager-impl.ts`
