description: Unit tests for runtime shared-cache covering threshold, invalidation, and edge-case streaming paths
files:
  - packages/quereus/src/runtime/cache/shared-cache.ts
  - packages/quereus/test/runtime/cache.spec.ts
----

## What was built

21 unit tests for `runtime/cache/shared-cache.ts` covering:

- **streamWithCache() core** (8 tests): cache population, cache-hit, row deep-copy on both build and cache-hit passes, threshold exceeded/boundary, zero/single row
- **Cache state management** (4 tests): clearCache, consumeCount, multiple sequential consumers, partial consumption
- **Cache abandoned path** (1 test): post-threshold consumers stream directly
- **Edge cases** (3 tests): source throws mid-stream, large rows, diverse SqlValue types
- **getCacheMetrics()** (3 tests): initial, cached, abandoned states
- **withSharedCache() / createCacheFunction()** (2 tests): factory helpers

## Review fix

During review, discovered that the cache-hit path (`yield* state.cachedResult`) yielded direct references to cached rows, meaning consumers could mutate the cache and corrupt data for subsequent consumers. The build path already copied via `[...row]`. Fixed the cache-hit path to also spread-copy, and added a test verifying mutation safety on the cache-hit path.

## Test results

- 21 cache tests passing
- Full suite: 1413 passing, 2 pending (baseline + 1 new test)
- Build clean
