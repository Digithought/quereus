/**
 * Browser-only exports for Quereus Plugin Store
 *
 * This entry point only exports the IndexedDB module and common utilities,
 * avoiding any Node.js-specific dependencies like LevelDB.
 *
 * Usage:
 *   import { IndexedDBModule, IndexedDBStore, StoreEventEmitter } from '@quereus/plugin-store/browser';
 */

// Re-export common utilities (these are platform-agnostic)
export * from './common/index.js';

// IndexedDB module (Browser-only)
export {
  IndexedDBStore,
  IndexedDBModule,
  IndexedDBTable,
  IndexedDBConnection,
  CrossTabSync,
  type IndexedDBModuleConfig,
} from './indexeddb/index.js';

// Platform info for consumers
export const platform = {
  isNode: false,
  isBrowser: true,
} as const;

