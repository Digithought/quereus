description: Unit tests for runtime shared-cache covering threshold, invalidation, and edge-case streaming paths
dependencies: none
files:
  - packages/quereus/src/runtime/cache/shared-cache.ts
  - packages/quereus/test/runtime/cache.spec.ts
----

## Summary

Added 21 unit tests for the shared cache module (`runtime/cache/shared-cache.ts`), covering all public functions and key behavioral paths.

## What was tested

### streamWithCache() core behavior
- First consumer populates cache; second reads from cache
- Cache hit returns identical row data
- Row deep-copy correctness on both build pass and cache-hit pass (mutation does not affect cache)
- Threshold exceeded → `cacheAbandoned` flag set, cache discarded
- Threshold boundary (exactly threshold rows retains cache)
- Zero rows and single row edge cases

### Cache state management
- `clearCache()` resets state; next consumer rebuilds from source
- `consumeCount` increments on each cached consumption (not on build pass)
- 5 sequential consumers all receive identical results
- Partial consumption via `break` — cache remains consistent for next consumer

### Edge cases
- Source throws mid-stream — cache not committed, next consumer can rebuild cleanly
- Large rows (100 columns) — spread copy works correctly, produces separate reference
- Diverse `SqlValue` types (string, number, BigInt, boolean, null, Uint8Array)

### Utility functions
- `getCacheMetrics()` — initial, cached, and abandoned states
- `withSharedCache()` — wrapper returns iterable + state
- `createCacheFunction()` — factory caches across calls

## Validation
- All 21 tests pass (`yarn workspace @quereus/quereus test --grep "Runtime Shared Cache"`)
- Tests are self-contained with no external dependencies beyond the cache module
