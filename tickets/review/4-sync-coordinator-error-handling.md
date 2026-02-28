---
description: Review sync-coordinator error handling improvements
dependencies: none
files:
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/server/routes.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/metrics/coordinator-metrics.ts
  - packages/sync-coordinator/test/websocket.spec.ts
  - packages/sync-coordinator/test/http.spec.ts
---

# Sync-Coordinator Error Handling — Review

All five error handling items are implemented and tested. 103 tests pass, build succeeds.

## What was implemented

### 1. WS handler individual try-catch
Each handler (`handleGetChanges`, `handleApplyChanges`, `handleGetSnapshot`, `handleResumeSnapshot`) has its own try-catch with specific error codes (`GET_CHANGES_ERROR`, `APPLY_CHANGES_ERROR`, `SNAPSHOT_ERROR`). `snapshot_complete` is only sent on success — the catch sends the error instead.

### 2. HTTP snapshot error chunk
`routes.ts` snapshot catch block writes `{ error: message }` as an NDJSON line before `reply.raw.end()`, allowing clients to detect truncated snapshots.

### 3. Broadcast error handling
`broadcastChanges()` in `coordinator-service.ts` wraps `socket.send()` in try-catch. On failure it logs with `serviceLog` and increments `broadcastErrorsTotal` counter metric (registered in `coordinator-metrics.ts`).

### 4. `resume_snapshot` handler
- `handleResumeSnapshot()` in `websocket.ts` — auth check, streams chunks via `service.resumeSnapshotStream()`, sends `snapshot_complete`
- `resumeSnapshotStream()` in `CoordinatorService` — delegates to `syncManager.resumeSnapshotStream(checkpoint)` with authorization, store management, and metric tracking

### 5. Tests
- `websocket.spec.ts`: `resume_snapshot` without auth → `NOT_AUTHENTICATED` ✓
- `websocket.spec.ts`: unknown message → `UNKNOWN_MESSAGE` ✓
- All existing HTTP and WS tests pass ✓

## Validation
- `yarn workspace @quereus/sync-coordinator build` — passes
- `yarn workspace @quereus/sync-coordinator test` — 103 passing
