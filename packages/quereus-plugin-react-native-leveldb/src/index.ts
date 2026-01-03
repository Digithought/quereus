/**
 * React Native LevelDB storage plugin for Quereus.
 *
 * Provides LevelDB-based persistent storage for React Native mobile environments
 * (iOS and Android).
 *
 * @example Using as a plugin (recommended)
 * ```typescript
 * import { LevelDB } from 'react-native-leveldb';
 * import { Database, registerPlugin } from '@quereus/quereus';
 * import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';
 *
 * const db = new Database();
 * await registerPlugin(db, leveldbPlugin, { openFn: LevelDB.open });
 *
 * await db.exec(`
 *   create table users (id integer primary key, name text)
 *   using store
 * `);
 * ```
 *
 * @example Using the provider directly
 * ```typescript
 * import { LevelDB } from 'react-native-leveldb';
 * import { createReactNativeLevelDBProvider } from '@quereus/plugin-react-native-leveldb';
 * import { StoreModule } from '@quereus/store';
 *
 * const provider = createReactNativeLevelDBProvider({ openFn: LevelDB.open });
 * const storeModule = new StoreModule(provider);
 * db.registerVtabModule('store', storeModule);
 * ```
 */

export { ReactNativeLevelDBStore, type LevelDB, type LevelDBIterator, type LevelDBOpenFn, type ReactNativeLevelDBStoreOptions } from './store.js';
export { ReactNativeLevelDBProvider, createReactNativeLevelDBProvider, type ReactNativeLevelDBProviderOptions } from './provider.js';
export { default as plugin, type ReactNativeLevelDBPluginConfig } from './plugin.js';

