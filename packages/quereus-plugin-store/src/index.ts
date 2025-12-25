/**
 * Persistent Store Plugin for Quereus
 *
 * Provides LevelDB (Node.js) and IndexedDB (browser) storage modules.
 *
 * Usage:
 *   import { LevelDBModule } from 'quereus-plugin-store';
 *   const leveldbModule = new LevelDBModule();
 *   db.registerModule('leveldb', leveldbModule);
 *
 * Or for browser:
 *   import { IndexedDBModule } from 'quereus-plugin-store';
 *   const indexeddbModule = new IndexedDBModule();
 *   db.registerModule('indexeddb', indexeddbModule);
 */

// Re-export common utilities
export * from './common/index.js';

// LevelDB module (Node.js)
export { LevelDBStore, LevelDBModule, LevelDBTable, type LevelDBModuleConfig } from './leveldb/index.js';

// IndexedDB module (Browser)
export { IndexedDBStore, IndexedDBModule, IndexedDBTable, CrossTabSync, type IndexedDBModuleConfig } from './indexeddb/index.js';

// Platform detection for conditional exports
const isNode = typeof process !== 'undefined'
  && process.versions != null
  && process.versions.node != null;

const isBrowser = typeof window !== 'undefined'
  && typeof window.indexedDB !== 'undefined';

// Export platform info for consumers
export const platform = {
  isNode,
  isBrowser,
} as const;

/**
 * Plugin manifest for Quereus plugin loader.
 */
export const manifest = {
  name: 'quereus-plugin-store',
  version: '0.1.0',
  author: 'Quereus Team',
  description: 'Persistent key-value storage using LevelDB (Node.js) or IndexedDB (browser)',
  provides: {
    vtables: ['leveldb', 'indexeddb'],
  },
};

