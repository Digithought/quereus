/**
 * NativeScript SQLite storage plugin for Quereus.
 *
 * Provides SQLite-based persistent storage for NativeScript mobile environments
 * (iOS and Android).
 *
 * @example Using as a plugin (recommended)
 * ```typescript
 * import { openOrCreate } from '@nativescript-community/sqlite';
 * import { Database, registerPlugin } from '@quereus/quereus';
 * import sqlitePlugin from '@quereus/plugin-nativescript-sqlite/plugin';
 *
 * const sqliteDb = openOrCreate('quereus.db');
 * const db = new Database();
 * await registerPlugin(db, sqlitePlugin, { db: sqliteDb });
 *
 * await db.exec(`
 *   create table users (id integer primary key, name text)
 *   using store
 * `);
 * ```
 *
 * @example Using the provider directly
 * ```typescript
 * import { openOrCreate } from '@nativescript-community/sqlite';
 * import { createSQLiteProvider } from '@quereus/plugin-nativescript-sqlite';
 * import { StoreModule } from '@quereus/store';
 *
 * const sqliteDb = openOrCreate('quereus.db');
 * const provider = createSQLiteProvider({ db: sqliteDb });
 * const storeModule = new StoreModule(provider);
 * db.registerModule('store', storeModule);
 * ```
 */

export { SQLiteStore, type SQLiteDatabase, type SQLiteStoreOptions } from './store.js';
export { SQLiteProvider, createSQLiteProvider, type SQLiteProviderOptions } from './provider.js';
export { default as plugin, type SQLitePluginConfig } from './plugin.js';

