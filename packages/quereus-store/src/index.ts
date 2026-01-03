/**
 * Abstract Store Module for Quereus
 *
 * Provides the generic StoreModule and KVStore abstractions for persistent storage.
 * Concrete implementations (LevelDB, IndexedDB) are in separate plugin packages:
 *   - @quereus/plugin-leveldb (Node.js)
 *   - @quereus/plugin-indexeddb (Browser)
 *
 * Usage:
 *   import { StoreModule, type KVStoreProvider } from '@quereus/store';
 *
 *   const provider: KVStoreProvider = createYourProvider();
 *   const module = new StoreModule(provider);
 *   db.registerVtabModule('store', module);
 */

// Export all common utilities and abstractions
export * from './common/index.js';

