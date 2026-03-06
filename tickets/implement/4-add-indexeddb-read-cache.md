description: Add a read-through in-memory cache to the IndexedDB KVStore to eliminate redundant IDB transactions
dependencies: none
files:
  - packages/quereus-store/src/common/cached-kv-store.ts (new)
  - packages/quereus-store/src/common/kv-store.ts (KVStore interface)
  - packages/quereus-store/src/index.ts (re-export)
  - packages/quereus-plugin-indexeddb/src/provider.ts (integrate cache)
  - packages/quereus-plugin-indexeddb/src/plugin.ts (cache config options)
  - packages/quereus-plugin-indexeddb/src/broadcast.ts (cross-tab invalidation)
  - packages/quereus-plugin-indexeddb/test/store.spec.ts (test coverage)
----

## Problem

The IndexedDB plugin has no application-level read caching. Every `get()`, `has()`, and
`iterate()` call opens a new IDB transaction and round-trips to IndexedDB. Unlike LevelDB
(which has built-in block cache and bloom filters), IndexedDB provides no internal read
cache accessible from JS.

For workloads with repeated reads of the same keys — PK lookups during joins, index probes,
catalog/stats metadata access — this creates unnecessary overhead. Each IDB transaction is
async, event-driven, and has measurable setup cost.

## Solution: CachedKVStore wrapper

A `CachedKVStore` class in `@quereus/store` that wraps any `KVStore` with a read-through
in-memory cache. Placed in the shared store package so it can be reused by other plugins
(React Native, NativeScript) if needed.

### Cache semantics

- **get()** — cache-first. On miss, read from underlying store and populate cache.
- **has()** — derived from cache state. If key is cached (value or negative), return
  immediately. Otherwise delegate to underlying.
- **put()** — write-through. Write to underlying, then update cache entry.
- **delete()** — write-through. Delete from underlying, then insert negative cache entry
  (key exists in cache with `undefined` value, meaning "known absent").
- **iterate()** — always delegates to underlying. Range queries are not cached (complex
  consistency, diminishing returns).
- **batch()** — delegates to underlying. On `write()`, invalidate all keys in the batch
  from the cache (conservative — no partial update).
- **approximateCount()** — delegates to underlying (infrequent, cheap enough).

### Eviction policy

Start with a simple LRU eviction policy. The companion ticket (3-improve-leveldb-cache)
explores 2Qs with correlated access intervals, but that complexity isn't warranted here
yet — IndexedDB currently has *no* cache at all, so even basic LRU is a large improvement.

The LRU implementation should be a simple doubly-linked list + Map, not a dependency.
Target ~1000 entries default (configurable). Each entry holds:
- key (Uint8Array, stored as hex string for Map key)
- value (Uint8Array | undefined for negative entries)
- size estimate (key.length + value.length for memory tracking)

### Memory budget

Optional `maxBytes` configuration caps total cached bytes. When exceeded, evict LRU entries
until under budget. Default: no byte limit (entry count limit only).

### Integration in IndexedDB provider

`IndexedDBProvider.getOrCreateStore()` wraps each `IndexedDBStore` in a `CachedKVStore`:

```typescript
private async getOrCreateStore(storeName: string): Promise<IndexedDBStore> {
    let store = this.stores.get(storeName);
    if (!store) {
        const raw = await IndexedDBStore.openForTable(this.databaseName, storeName);
        store = new CachedKVStore(raw, this.cacheOptions);
        this.stores.set(storeName, store);
    }
    return store;
}
```

Cache options flow from plugin config:

```typescript
interface IndexedDBPluginConfig {
    // ... existing options ...
    cache?: {
        maxEntries?: number;  // default 1000
        maxBytes?: number;    // default unlimited
        enabled?: boolean;    // default true
    };
}
```

### Cross-tab cache invalidation

The existing `CrossTabSync` / `BroadcastChannel` infrastructure emits `DataChangeEvent`
when data changes. On receiving a remote change event, the provider should invalidate
affected cache entries. This requires:

1. `CachedKVStore` exposes an `invalidate(key)` and `invalidateAll()` method.
2. `CrossTabSync` message handler calls `invalidateAll()` on affected stores (or
   `invalidate(key)` if the event includes key info).
3. Conservative: on any remote data-change event for a table, `invalidateAll()` on
   that table's cache. Fine-grained per-key invalidation is a future optimization.

### What NOT to cache

- **Iteration results** — range consistency is hard; stale ranges cause incorrect query
  results. Not worth the complexity.
- **Stats store** — already has in-memory caching in `StoreTable.cachedStats`.
- **Catalog store** — accessed rarely after startup; not worth caching.

## Key tests

- get() returns cached value on second call without hitting underlying
- put() updates cache so subsequent get() sees new value
- delete() results in cache returning undefined on get()
- Eviction: inserting beyond maxEntries evicts oldest entries
- Batch write invalidates affected keys
- Cache can be disabled via config
- Cross-tab invalidation clears cache on remote event
- iterate() always delegates to underlying (no stale range data)
- Negative cache entries: get() for non-existent key, then get() again should not hit underlying

## TODO

- Create `CachedKVStore` class in `packages/quereus-store/src/common/cached-kv-store.ts`
  - LRU eviction with doubly-linked list + Map
  - Negative cache entries for known-absent keys
  - Write-through on put/delete
  - Batch invalidation
  - `invalidate(key)` and `invalidateAll()` public methods
  - Configurable maxEntries and maxBytes
- Export from `packages/quereus-store/src/index.ts`
- Integrate into `IndexedDBProvider.getOrCreateStore()` in `packages/quereus-plugin-indexeddb/src/provider.ts`
- Add cache config to `IndexedDBPluginConfig` in `packages/quereus-plugin-indexeddb/src/plugin.ts`
- Add cross-tab cache invalidation in `packages/quereus-plugin-indexeddb/src/broadcast.ts`
- Add tests in `packages/quereus-plugin-indexeddb/test/store.spec.ts` (or a new `cache.spec.ts`)
- Ensure build and tests pass
