/**
 * IndexedDB module exports for browser environments.
 */

export { IndexedDBStore } from './store.js';
export { IndexedDBModule, type IndexedDBModuleConfig } from './module.js';
export { IndexedDBTable } from './table.js';
export { IndexedDBConnection } from './connection.js';
export { CrossTabSync } from './broadcast.js';

// Unified database architecture (Phase 7)
export {
  UnifiedIndexedDBManager,
  UnifiedIndexedDBStore,
  MultiStoreWriteBatch,
  type UnifiedKVStoreOptions,
} from './unified-database.js';

export {
  UnifiedIndexedDBModule,
  type UnifiedIndexedDBModuleConfig,
} from './unified-module.js';

