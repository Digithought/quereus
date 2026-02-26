---
description: Fix resource management bugs in sync-coordinator (eviction race, socket close leaks, cleanup/shutdown race)
dependencies: none
files:
  - packages/sync-coordinator/src/service/store-manager.ts
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/test/store-manager.spec.ts
---

# Resource Management Bug Fixes

## Changes

### 1. Store Eviction Race Condition (store-manager.ts)

`closeStore()` now re-checks `entry.refCount > 0` before closing. This guards against the race where another async operation acquires the store between the eviction candidate selection in `evictLRU()`/`cleanup()` and the actual close.

### 2. Socket Close During Handshake (websocket.ts)

Added `socketClosed` flag tracked by the close handler. After `registerSession()` completes, `handleHandshake()` checks this flag and calls `unregisterSession()` if the socket closed during the async registration — preventing a leaked store reference.

### 3. Handshake Error Cleanup (websocket.ts)

The catch block in `handleHandshake()` now checks if `session` was assigned (i.e., `registerSession()` succeeded) and calls `unregisterSession()` before closing the socket. This prevents a leaked store reference when `getSiteId()` or `sendMessage()` throws after successful registration.

### 4. Cleanup Interval Race With Shutdown (store-manager.ts)

Added `_shuttingDown` flag set at the start of `shutdown()` and checked at the start of `cleanup()`. Prevents the cleanup interval callback from iterating the stores map while shutdown is concurrently closing and clearing it.

## Testing

- New test: "should not evict a store that was re-acquired before close" — verifies the refCount guard in `closeStore()`
- New test: "should close idle stores past timeout" — verifies cleanup works for idle stores
- New test: "should not close stores with active references" — verifies cleanup respects refCount
- New test: "should not run cleanup after shutdown begins" — verifies shutdown/cleanup coordination
- All 91 tests pass

## Validation

- `yarn workspace @quereus/sync-coordinator build` — clean
- `yarn workspace @quereus/sync-coordinator test` — 91 passing
