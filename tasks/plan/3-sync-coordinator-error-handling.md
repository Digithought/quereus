---
description: Error handling gaps in sync-coordinator endpoints and broadcast
dependencies: none

---

# Error Handling Gaps

## 1. Unhandled Async Iteration in WS Snapshot Handler

**File:** `packages/sync-coordinator/src/server/websocket.ts` — `handleGetSnapshot()` at ~line 212

The `for await...of` loop over `getSnapshotStream()` has no try-catch. Errors during streaming propagate to the outer message handler's generic catch, giving the client an unhelpful `MESSAGE_ERROR`.

**Expected:** Wrap in try-catch, send a specific snapshot error message, and ensure the async generator is properly cleaned up.

## 2. Swallowed HTTP Snapshot Errors

**File:** `packages/sync-coordinator/src/server/routes.ts` — snapshot catch block at ~lines 191-195

When an error occurs mid-stream, the response is silently ended with `reply.raw.end()`. Clients receive a truncated NDJSON stream with no error indication.

**Expected:** Write an error chunk (e.g., `{"error": "..."}`) before ending the stream so clients can detect failures.

## 3. Missing Broadcast Error Handling

**File:** `packages/sync-coordinator/src/service/coordinator-service.ts` — `broadcastChanges()` at ~line 591

`session.socket.send(message)` is called without error handling. If the send fails, the error is silently swallowed. No logging, no metrics.

**Expected:** Wrap in try-catch, log failures, increment a metric counter.

## 4. WS Message Handlers Lack Individual Try-Catch

**File:** `packages/sync-coordinator/src/server/websocket.ts` — `handleGetChanges()`, `handleApplyChanges()` at ~lines 172-217

Individual handlers have no try-catch. They rely on the outer catch which sends a generic `MESSAGE_ERROR`. Deserialization errors (invalid base64, malformed data) are indistinguishable from server errors.

**Expected:** Each handler should catch its own errors and send specific error codes.

## 5. Missing `resume_snapshot` Handler

**File:** `packages/sync-coordinator/src/server/websocket.ts` — switch statement at ~lines 94-112

`ResumeSnapshotMessage` is defined in the `ClientMessage` union type (lines 47-50, 56-62) but has no case in the switch. It falls through to `UNKNOWN_MESSAGE` error.

**Expected:** Either implement the handler or remove the type from the union until it's ready.

