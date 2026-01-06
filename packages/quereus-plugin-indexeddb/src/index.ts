/**
 * IndexedDB storage plugin for Quereus.
 *
 * Provides IndexedDB-based persistent storage for browser environments.
 *
 * @example Using as a plugin (recommended)
 * ```typescript
 * import { Database, registerPlugin } from '@quereus/quereus';
 * import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';
 *
 * const db = new Database();
 * await registerPlugin(db, indexeddbPlugin, { prefix: 'myapp' });
 *
 * await db.exec(`
 *   create table users (id integer primary key, name text)
 *   using store
 * `);
 * ```
 *
 * @example Using the provider directly
 * ```typescript
 * import { createIndexedDBProvider } from '@quereus/plugin-indexeddb';
 * import { StoreModule } from '@quereus/store';
 *
 * const provider = createIndexedDBProvider({ prefix: 'myapp' });
 * const storeModule = new StoreModule(provider);
 * db.registerModule('store', storeModule);
 * ```
 */

export { IndexedDBStore, MultiStoreWriteBatch, type IndexedDBStoreOptions } from './store.js';
export { IndexedDBManager } from './manager.js';
export { IndexedDBProvider, createIndexedDBProvider, type IndexedDBProviderOptions } from './provider.js';
export { CrossTabSync } from './broadcast.js';
export { default as plugin, type IndexedDBPluginConfig } from './plugin.js';

