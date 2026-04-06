description: Unit tests for runtime shared-cache covering threshold, invalidation, and edge-case streaming paths
dependencies: none
files:
  - packages/quereus/src/runtime/cache/shared-cache.ts
  - packages/quereus/test/runtime/cache.spec.ts (new)
----

## Summary

Added 20 unit tests for `runtime/cache/shared-cache.ts` in a new test file `packages/quereus/test/runtime/cache.spec.ts`.

## What was tested

### streamWithCache() core behavior (7 tests)
- First consumer populates cache
- Cache hit returns identical data on second pass
- Row deep-copy correctness — mutating yielded row doesn't affect cache
- Threshold exceeded — cache abandoned, flag set
- Threshold boundary — exactly threshold rows keeps cache
- Zero rows — empty cache populated
- Single row — cache populated correctly

### Cache state management (4 tests)
- clearCache() resets state, next consumer rebuilds from source
- consumeCount increments on each cached consumption (not on build pass)
- Multiple sequential consumers (5x) all get identical results
- Partial consumption (break mid-stream) doesn't corrupt cache for next consumer

### Cache abandoned path (1 test)
- After threshold exceeded, subsequent consumers stream directly from source

### Edge cases (3 tests)
- Source throws mid-stream — cache not committed, next consumer rebuilds cleanly
- Large rows (100 columns) — spread copy works correctly
- Diverse SqlValue types (string, number, bigint, boolean, null, Uint8Array)

### getCacheMetrics() (3 tests)
- Reports initial state, cached state, and abandoned state correctly

### withSharedCache() and createCacheFunction() (2 tests)
- Factory helpers populate cache and serve from it on subsequent calls

## Validation
- All 20 new tests pass
- Full suite: 1412 passing, 2 pending (unchanged baseline)
