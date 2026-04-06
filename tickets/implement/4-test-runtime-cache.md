description: Unit tests for runtime shared-cache covering threshold, invalidation, and edge-case streaming paths
dependencies: none
files:
  - packages/quereus/src/runtime/cache/shared-cache.ts
  - packages/quereus/test/runtime/cache.spec.ts (new)
----

## Motivation

`runtime/cache/` has 71% line coverage but only 33% function coverage. Cache logic is a classic bug habitat — invalidation, stale reads, threshold behavior, and concurrent access are all under-tested.

## What to test

### streamWithCache() core behavior

- **First consumer populates cache**: stream rows, verify cache is built and second consumer reads from cache
- **Cache hit returns identical data**: compare row-by-row output of first pass vs cached pass
- **Row deep-copy correctness**: mutate a yielded row after iteration, verify cached copy is unaffected (tests the `[...row]` spread)
- **Threshold exceeded → cache abandoned**: set a low threshold, stream more rows than threshold, verify `cacheAbandoned` flag is set and subsequent consumers stream directly
- **Threshold boundary**: exactly threshold rows — verify cache is retained (not abandoned)
- **Zero rows**: empty source stream — cache should be populated (empty), not abandoned
- **Single row**: one-row source stream — cache populated correctly

### Cache state management

- **clearCache()**: populate cache, clear it, verify next consumer re-streams from source
- **consumeCount tracking**: verify count increments on each full consumption
- **Multiple sequential consumers**: 3+ consumers after cache populated — all get identical results
- **Partial consumption**: consumer stops mid-stream (break/return) — verify cache state is still consistent for next consumer

### Edge cases

- **Source throws mid-stream**: async generator that throws after N rows — verify cache state is not corrupted, next consumer gets a clean error
- **Large rows**: rows with many columns — verify spread copy works correctly
- **Non-array Row types**: if Row can be a non-array type, verify copy semantics still hold
