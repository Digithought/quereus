/**
 * LevelDB storage plugin for Quereus.
 *
 * Provides LevelDB-based persistent storage for Node.js environments.
 *
 * @example Using as a plugin (recommended)
 * ```typescript
 * import { Database, registerPlugin } from '@quereus/quereus';
 * import leveldbPlugin from '@quereus/plugin-leveldb/plugin';
 *
 * const db = new Database();
 * await registerPlugin(db, leveldbPlugin, { basePath: './data' });
 *
 * await db.exec(`
 *   create table users (id integer primary key, name text)
 *   using store
 * `);
 * ```
 *
 * @example Using the provider directly
 * ```typescript
 * import { createLevelDBProvider } from '@quereus/plugin-leveldb';
 * import { StoreModule } from '@quereus/store';
 *
 * const provider = createLevelDBProvider({ basePath: './data' });
 * const storeModule = new StoreModule(provider);
 * db.registerVtabModule('store', storeModule);
 * ```
 */

export { LevelDBStore } from './store.js';
export { LevelDBProvider, createLevelDBProvider, type LevelDBProviderOptions } from './provider.js';
export { default as plugin, type LevelDBPluginConfig } from './plugin.js';

