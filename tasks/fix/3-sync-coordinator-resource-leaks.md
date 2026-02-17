---
description: Resource management bugs in sync-coordinator (eviction race, socket close leaks)
dependencies: none
priority: 3
---

# Resource Management Bugs

## 1. Store Eviction Race Condition (CRITICAL)

**File:** `packages/sync-coordinator/src/service/store-manager.ts` — `evictLRU()` at ~lines 307-325

Between checking `entry.refCount === 0` and calling `closeStore()`, another async operation can increment the refCount. The store is closed while still in use.

**Fix:** Re-check `refCount === 0` inside `closeStore()` or use an atomic check-and-close pattern.

## 2. Socket Close During Handshake Leaks Store Reference

**File:** `packages/sync-coordinator/src/server/websocket.ts` — socket close handler at ~lines 120-125

If the socket closes after `registerSession()` acquires a store but before the `session` variable is assigned, the close handler sees `session === null` and skips `unregisterSession()`. The acquired store reference is never released.

**Fix:** Track whether `registerSession()` was called so the close handler can clean up regardless of `session` assignment.

## 3. Handshake Error Doesn't Clean Up Acquired Store

**File:** `packages/sync-coordinator/src/server/websocket.ts` — handshake catch block at ~lines 162-166

If `registerSession()` succeeds but a subsequent operation in the handshake throws, the catch block closes the socket without calling `unregisterSession()`.

**Fix:** Add cleanup in the handshake catch block: if `session` was partially set up, call `unregisterSession()`.

## 4. Cleanup Interval Race With Shutdown

**File:** `packages/sync-coordinator/src/service/store-manager.ts` — `shutdown()` at ~lines 223-247

If `cleanup()` is running when `shutdown()` is called, they can interfere — cleanup iterates stores while shutdown closes and clears them.

**Fix:** Use a shutdown flag checked at the start of `cleanup()`.

