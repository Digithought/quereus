---
description: Resolved DRY violations in sync-coordinator (serialization, storage path resolver, hasSnapshot stub)
files:
  - packages/sync-coordinator/src/common/serialization.ts (new)
  - packages/sync-coordinator/src/common/index.ts
  - packages/sync-coordinator/src/service/s3-config.ts
  - packages/sync-coordinator/src/service/s3-batch-store.ts
  - packages/sync-coordinator/src/service/s3-snapshot-store.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/service/index.ts
  - packages/sync-coordinator/src/index.ts
---

# Changes

## 1. Extracted `serializeChangeSet` / `deserializeChangeSet`

Created `src/common/serialization.ts` with shared implementations. Removed the duplicate standalone function from `websocket.ts` and the private method from `CoordinatorService`. Both now import from the shared module via `common/index.ts`.

## 2. Extracted `StoragePathResolver` type and `defaultStoragePathResolver`

Moved the duplicated type and default implementation from both `s3-batch-store.ts` and `s3-snapshot-store.ts` into `s3-config.ts` (the existing shared S3 config module). Both stores now import from there. Re-exports updated in `service/index.ts` and root `index.ts`.

## 3. Implemented `hasSnapshot()`

Replaced the stub (always returning `false`) in `S3SnapshotStore` with a real implementation using `ListObjectsV2Command` with `MaxKeys: 1` to efficiently check for any snapshot objects under the database's snapshot prefix.

## Testing & Validation

- `yarn workspace @quereus/sync-coordinator build` — passes
- `yarn workspace @quereus/sync-coordinator test` — all 86 tests pass
- Unused imports (`serializeHLC`) cleaned up from both `websocket.ts` and `coordinator-service.ts`
