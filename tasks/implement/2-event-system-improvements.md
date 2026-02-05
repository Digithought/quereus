---
description: Event system memory management and documentation improvements
dependencies: none
priority: 2
---

# Event System Improvements

## Problems

### Memory Management Concerns

1. **No listener count limit**: A misbehaving consumer could register thousands of listeners
2. **No warning on close**: `removeAllListeners()` doesn't warn about lingering listeners (indicates consumer bugs)
3. **Strong references only**: No WeakRef option for listeners that should be auto-cleaned

### Documentation Gaps

1. **Event ordering not documented**: Schema events before data, cross-layer order may not be preserved
2. **Memory management not documented**: Best practices for listener cleanup

## Key Files

- `packages/quereus/src/core/database-events.ts`
- `docs/module-authoring.md` or `docs/usage.md`

## TODO

### Listener Management
- [ ] Add configurable max listener count (default 100) with warning when exceeded
- [ ] Log warning in `removeAllListeners()` if listeners were still registered
- [ ] Consider optional `listenerCount()` method for debugging

### Documentation
- [ ] Document event ordering guarantees in usage.md or module-authoring.md:
  - Schema events emitted before data events
  - Within categories, events from nested savepoints are flattened
  - Cross-layer chronological order may not be preserved
- [ ] Document listener memory management best practices:
  - Always call returned unsubscribe function
  - Use weak references for UI components if available
  - Clean up listeners before discarding Database instance

### Optional Enhancements (lower priority)
- [ ] Add event filtering at subscription time (tables, schemas, operations)
- [ ] Add batch size monitoring (warn when >10k events queued)
- [ ] Consider async listener variant for expensive handlers
