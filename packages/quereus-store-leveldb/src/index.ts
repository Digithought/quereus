/**
 * LevelDB KVStore implementation for Quereus.
 *
 * Provides a LevelDB-based KVStore for Node.js environments.
 * This package contains only the store implementation - use quereus-plugin-store
 * for the full virtual table module.
 *
 * @example
 * ```typescript
 * import { LevelDBStore, createLevelDBProvider } from 'quereus-store-leveldb';
 * import { StoreModule } from 'quereus-plugin-store';
 *
 * // Using the provider with StoreModule
 * const provider = createLevelDBProvider({ basePath: './data' });
 * const storeModule = new StoreModule(provider);
 * db.registerVtabModule('store', storeModule);
 *
 * // Or use LevelDBStore directly
 * const store = await LevelDBStore.open({ path: './data/mydb' });
 * await store.put(key, value);
 * await store.close();
 * ```
 */

export { LevelDBStore } from './store.js';
export { LevelDBProvider, createLevelDBProvider, type LevelDBProviderOptions } from './provider.js';

