---
description: Fixed BigInt serialization bug in sync-coordinator snapshot endpoints
dependencies: none
files:
  - packages/sync-coordinator/src/common/serialization.ts
  - packages/sync-coordinator/src/common/index.ts
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/server/routes.ts
  - packages/sync-coordinator/test/websocket.spec.ts
---

# Snapshot Serialization Bug — Fix Summary

## Problem

Both WebSocket `handleGetSnapshot()` / `handleResumeSnapshot()` and HTTP `GET /:databaseId/snapshot` endpoints failed with `"Do not know how to serialize a BigInt"` because raw `SnapshotChunk` objects (containing `HLC` with `bigint wallTime` and `SiteId` as `Uint8Array`) were passed directly to `JSON.stringify()`.

## Fix

Added `serializeSnapshotChunk()` in `serialization.ts` alongside the existing `serializeChangeSet()`. It handles each chunk type:

- **header**: serializes `siteId` → base64url, `hlc` → base64 (via `serializeHLC`)
- **column-versions**: serializes each entry's HLC → base64
- **schema-migration**: serializes `migration.hlc` → base64
- **table-start, table-end, footer**: passed through unchanged (no binary fields)

Wired the serializer into:
- `websocket.ts`: `handleGetSnapshot()` and `handleResumeSnapshot()`
- `routes.ts`: HTTP snapshot streaming route

## Testing

- Updated `websocket.spec.ts` test from expecting a `BigInt` error to asserting successful `snapshot_chunk` + `snapshot_complete` messages, and verifying that serialized fields are strings.
- All 91 tests pass.

## Validation

- `yarn workspace @quereus/sync-coordinator build` — clean
- `yarn workspace @quereus/sync-coordinator test` — 91 passing
