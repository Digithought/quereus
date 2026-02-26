---
description: Fix error handling gaps in sync-coordinator WS handlers, HTTP snapshot streaming, and broadcast
dependencies: none
files:
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/server/routes.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/test/websocket.spec.ts
  - packages/sync-coordinator/test/http.spec.ts
---

# Sync-Coordinator Error Handling

Five error handling gaps to fix across websocket handlers, HTTP routes, and broadcast.

## 1. WS handlers: individual try-catch with specific error codes

**File:** `websocket.ts` — `handleGetChanges()`, `handleApplyChanges()`, `handleGetSnapshot()`

Each handler currently relies on the outer catch which sends a generic `MESSAGE_ERROR`. Wrap each handler body in its own try-catch that sends a specific error code:

- `handleGetChanges`: catch → `GET_CHANGES_ERROR`
- `handleApplyChanges`: catch → `APPLY_CHANGES_ERROR`
- `handleGetSnapshot`: catch → `SNAPSHOT_ERROR`, also ensure `snapshot_complete` is NOT sent on failure

This also addresses the snapshot streaming gap (issue #1 from the plan) — the `for await` loop in `handleGetSnapshot()` gets wrapped with proper error handling.

## 2. HTTP snapshot: write error chunk before ending stream

**File:** `routes.ts` — snapshot catch block (~line 191)

When an error occurs mid-stream, write a JSON error line before ending:
```
reply.raw.write(JSON.stringify({ error: message }) + '\n');
reply.raw.end();
```

This lets NDJSON clients detect truncated snapshots.

## 3. Broadcast error handling

**File:** `coordinator-service.ts` — `broadcastChanges()` (~line 590)

Wrap `session.socket.send(message)` in try-catch. On failure:
- Log the error with `serviceLog`
- Increment a new `broadcastErrorsTotal` counter metric

Add the metric to `createCoordinatorMetrics()` in `packages/sync-coordinator/src/metrics/index.ts`.

## 4. `resume_snapshot` handler

**File:** `websocket.ts` — switch statement

`ResumeSnapshotMessage` is in the `ClientMessage` union but has no case. The underlying `SyncManager.resumeSnapshotStream(checkpoint)` exists in `@quereus/sync`.

Implement the handler:
- Require auth (like other handlers)
- Deserialize the checkpoint from the message
- Stream chunks via `service.resumeSnapshotStream(databaseId, identity, checkpoint)`
- Send `snapshot_complete` when done

This requires adding `resumeSnapshotStream()` to `CoordinatorService` — it follows the same pattern as `getSnapshotStream()` but delegates to `entry.syncManager.resumeSnapshotStream(checkpoint)`.

## 5. Testing

Update existing tests:
- `test/websocket.spec.ts`: test that `resume_snapshot` without auth returns `NOT_AUTHENTICATED`; test that unknown message after the fix still returns `UNKNOWN_MESSAGE`
- `test/http.spec.ts`: existing snapshot tests should still pass; verify error chunk behavior if feasible

----

## TODO

### Phase 1: WS handler error wrapping
- Add try-catch to `handleGetChanges()` sending `GET_CHANGES_ERROR`
- Add try-catch to `handleApplyChanges()` sending `APPLY_CHANGES_ERROR`
- Add try-catch to `handleGetSnapshot()` sending `SNAPSHOT_ERROR`, skip `snapshot_complete` on error

### Phase 2: HTTP snapshot error chunk
- In `routes.ts` snapshot catch block, write `{"error": "..."}` NDJSON line before `reply.raw.end()`

### Phase 3: Broadcast error handling
- Add `broadcastErrorsTotal` counter to metrics
- Wrap `socket.send()` in try-catch in `broadcastChanges()`, log + increment metric

### Phase 4: resume_snapshot handler
- Add `resumeSnapshotStream()` method to `CoordinatorService` (delegates to `syncManager.resumeSnapshotStream`)
- Add `case 'resume_snapshot':` to WS switch with `handleResumeSnapshot()` handler
- Handler: auth check, deserialize checkpoint, stream chunks, send `snapshot_complete`

### Phase 5: Tests
- Add WS test: `resume_snapshot` without auth → `NOT_AUTHENTICATED`
- Verify existing tests still pass
- Build passes
