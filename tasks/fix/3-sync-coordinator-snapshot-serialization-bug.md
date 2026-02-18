---
description: BigInt serialization bug in sync-coordinator snapshot endpoints (WS and HTTP)
dependencies: none

---

# Snapshot Serialization Bug

## Problem

Both the WebSocket `handleGetSnapshot()` and HTTP `GET /:databaseId/snapshot` endpoints fail when streaming snapshot chunks because `JSON.stringify()` cannot serialize `BigInt` values.

`SnapshotChunk` objects contain `HLC` fields (with `wallTime: bigint`) and `SiteId` fields (`Uint8Array`). The `get_changes` handler correctly serializes these via `serializeChangeSet()` which converts HLC to base64 and SiteId to base64url, but no equivalent serialization exists for snapshot chunks.

## Expected Behavior

Snapshot streaming should serialize `HLC` and `SiteId` fields the same way change sets do — using `hlcToJson()`/`siteIdToBase64()` or equivalent base64 encoding before `JSON.stringify()`.

## Reproduction

1. Connect via WebSocket, complete handshake
2. Send `{ type: 'get_snapshot' }`
3. Server throws `"Do not know how to serialize a BigInt"` internally

Same happens via HTTP `GET /:databaseId/snapshot`.

## Affected Files

- `packages/sync-coordinator/src/server/websocket.ts` — `handleGetSnapshot()` at ~line 212, sends raw `SnapshotChunk` via `JSON.stringify`
- `packages/sync-coordinator/src/server/routes.ts` — snapshot route at ~line 185, same issue
- Need a `serializeSnapshotChunk()` function analogous to `serializeChangeSet()`

## Notes

- Test in `test/websocket.spec.ts` documents this bug ("known bug: BigInt serialization")
- The `serializeChangeSet()` function already exists in two places (see DRY violation task) — the new serializer should be shared

