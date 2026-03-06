description: Read-through in-memory LRU cache for IndexedDB KVStore — eliminates redundant IDB transactions
dependencies: none
files:
  - packages/quereus-store/src/common/cached-kv-store.ts (new — CachedKVStore class)
  - packages/quereus-store/src/common/index.ts (re-export CachedKVStore, CacheOptions)
  - packages/quereus-plugin-indexeddb/src/provider.ts (wraps data/index stores with CachedKVStore)
  - packages/quereus-plugin-indexeddb/src/plugin.ts (cache config in IndexedDBPluginConfig)
  - packages/quereus-plugin-indexeddb/src/broadcast.ts (cross-tab cache invalidation)
  - packages/quereus-plugin-indexeddb/test/cache.spec.ts (new — 20 tests)
----

## What was built

A `CachedKVStore` wrapper in `@quereus/store` that adds read-through in-memory caching
to any `KVStore` implementation. Integrated into the IndexedDB plugin so every data and
index store is automatically wrapped with the cache (stats and catalog stores are excluded).

### Cache semantics

- **get()/has()** — cache-first; on miss, reads from underlying and populates cache (including negative entries for absent keys)
- **put()** — write-through; writes to underlying then updates cache
- **delete()** — write-through; deletes from underlying then inserts negative cache entry
- **iterate()/approximateCount()** — always delegates to underlying (no range caching)
- **batch()** — delegates to underlying; invalidates all batch keys on `write()`
- **invalidate(key)/invalidateAll()** — public methods for external invalidation

### LRU implementation

Doubly-linked list + Map. No external dependencies. Configurable `maxEntries` (default 1000)
and optional `maxBytes` budget.

### Cross-tab invalidation

`CrossTabSync` now accepts an optional `IndexedDBProvider` reference. On receiving a remote
`DataChangeEvent`, it calls `invalidateCache(schemaName, tableName)` on the provider, which
clears the affected store's cache. Falls back to `invalidateAllCaches()` if schema/table info
is missing.

### Configuration

```typescript
// Via plugin config
register(db, {
  cache: { maxEntries: 2000, maxBytes: 5_000_000, enabled: true }
});

// Via provider options
new IndexedDBProvider({
  databaseName: 'mydb',
  cache: { maxEntries: 500 }
});
```

Cache is enabled by default. Set `enabled: false` to disable.

## Key test cases (20 tests in cache.spec.ts)

- get() returns cached value on second call without hitting underlying
- Negative cache: get() for absent key caches undefined, second get() skips underlying
- put() updates cache so subsequent get() sees new value without underlying call
- put() replaces negative cache entry with real value
- delete() inserts negative cache entry
- has() returns from cache without underlying call
- iterate() always delegates to underlying
- LRU eviction by maxEntries
- LRU eviction by maxBytes
- LRU position refresh on access
- Batch write invalidates affected keys
- Cache disabled mode (all ops pass through)
- invalidate(key) clears single entry
- invalidateAll() clears all entries
- getUnderlying() returns wrapped store

All 49 tests pass (20 new + 29 existing).

## Usage

The cache is automatically enabled when using the IndexedDB plugin. No configuration
needed for the default behavior. To customize:

```typescript
import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';

await registerPlugin(db, indexeddbPlugin, {
  databaseName: 'myapp',
  cache: { maxEntries: 2000 },
});
```
