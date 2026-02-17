---
description: DRY violations in sync-coordinator (duplicated serialization, storage path resolver)
dependencies: none
priority: 3
---

# DRY Violations

## 1. Duplicated `serializeChangeSet`

The same serialization logic exists in two places:

- `packages/sync-coordinator/src/server/websocket.ts` — standalone function at lines 225-239
- `packages/sync-coordinator/src/service/coordinator-service.ts` — private method at lines 608-629

Both convert `ChangeSet` fields (siteId → base64url, HLC → base64, transactionId → base64url) for JSON transport. Minor style differences but identical logic.

**Fix:** Extract into a shared utility (e.g., `src/common/serialization.ts`) and import from both locations. The corresponding `deserializeChangeSet` should live there too.

## 2. Duplicated `StoragePathResolver` Type and Default Implementation

Identical type and function in two S3 store files:

- `packages/sync-coordinator/src/service/s3-batch-store.ts` — type at line 43, function at lines 49-52
- `packages/sync-coordinator/src/service/s3-snapshot-store.ts` — type at line 77, function at lines 82-84

Both define:
```typescript
type StoragePathResolver = (databaseId: string) => string;
function defaultStoragePathResolver(databaseId: string): string {
  return databaseId.replace(/:/g, '/').replace(/[^a-zA-Z0-9/_-]/g, '_');
}
```

**Fix:** Extract into `src/common/storage-path.ts` or `src/service/s3-config.ts` (which already exists for S3 utilities).

## 3. `hasSnapshot()` Stub

**File:** `packages/sync-coordinator/src/service/s3-snapshot-store.ts` — lines 273-280

`hasSnapshot()` always returns `false` with a comment "simplified for now". This means snapshot existence checks never work, which affects any logic depending on pre-existing snapshots.

**Fix:** Implement using S3 ListObjects or HeadObject, or document the limitation clearly and add a TODO.

