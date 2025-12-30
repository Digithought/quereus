/**
 * IndexedDB KVStore implementation for Quereus.
 *
 * Provides IndexedDB-based KVStore implementations for browser environments.
 * This package contains only the store implementation - use quereus-plugin-store
 * for the full virtual table module.
 *
 * @example
 * ```typescript
 * import { IndexedDBStore, createIndexedDBProvider } from 'quereus-store-indexeddb';
 * import { StoreModule } from 'quereus-plugin-store';
 *
 * // Using the provider with StoreModule
 * const provider = createIndexedDBProvider({ prefix: 'myapp' });
 * const storeModule = new StoreModule(provider);
 * db.registerVtabModule('store', storeModule);
 *
 * // Or use IndexedDBStore directly
 * const store = await IndexedDBStore.open({ path: 'my-database' });
 * await store.put(key, value);
 * await store.close();
 * ```
 */

export { IndexedDBStore } from './store.js';
export { IndexedDBProvider, createIndexedDBProvider, type IndexedDBProviderOptions } from './provider.js';
export { CrossTabSync } from './broadcast.js';

