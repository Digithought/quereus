/**
 * Persistent Store Plugin for Quereus
 *
 * Provides LevelDB (Node.js) and IndexedDB (browser) storage modules.
 *
 * Usage with registerPlugin (auto-detects platform):
 *   import { Database, registerPlugin } from '@quereus/quereus';
 *   import storePlugin from 'quereus-plugin-store';
 *   await registerPlugin(db, storePlugin, { path: './data' });
 *
 * Manual usage (Node.js):
 *   import { LevelDBModule } from 'quereus-plugin-store';
 *   const leveldbModule = new LevelDBModule();
 *   db.registerVtabModule('store', leveldbModule);
 *
 * Manual usage (Browser):
 *   import { IndexedDBModule } from 'quereus-plugin-store';
 *   const indexeddbModule = new IndexedDBModule();
 *   db.registerVtabModule('store', indexeddbModule);
 */

import { QuereusError, StatusCode, type Database, type SqlValue } from '@quereus/quereus';
import { LevelDBModule } from './leveldb/index.js';
import { IndexedDBModule } from './indexeddb/index.js';

// Re-export common utilities
export * from './common/index.js';

// LevelDB module (Node.js)
export { LevelDBStore, LevelDBModule, LevelDBTable, LevelDBConnection, TransactionCoordinator, type LevelDBModuleConfig, type TransactionCallbacks } from './leveldb/index.js';

// IndexedDB module (Browser)
export {
  IndexedDBStore,
  IndexedDBModule,
  IndexedDBTable,
  IndexedDBConnection,
  CrossTabSync,
  type IndexedDBModuleConfig,
  // Unified database architecture (Phase 7)
  UnifiedIndexedDBManager,
  UnifiedIndexedDBStore,
  UnifiedIndexedDBModule,
  MultiStoreWriteBatch,
  type UnifiedKVStoreOptions,
  type UnifiedIndexedDBModuleConfig,
} from './indexeddb/index.js';

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
 * Plugin registration function - auto-detects platform and registers appropriate module.
 *
 * Config options:
 * - moduleName: string - Name to register the module as (default: 'store')
 *
 * Note: Per-table configuration (path, database name) is passed via CREATE TABLE options:
 *   CREATE TABLE t (id INTEGER PRIMARY KEY) USING store(path='./data/t')
 *
 * @example
 * ```typescript
 * import { Database, registerPlugin } from '@quereus/quereus';
 * import storePlugin from 'quereus-plugin-store';
 *
 * const db = new Database();
 * await registerPlugin(db, storePlugin);
 *
 * // Now use 'store' in CREATE TABLE:
 * await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING store(path='./users')");
 * ```
 */
export default function register(
  _db: Database,
  config: Record<string, SqlValue> = {}
) {
  const moduleName = typeof config.moduleName === 'string' ? config.moduleName : 'store';

  let module: LevelDBModule | IndexedDBModule;

  if (isNode) {
    module = new LevelDBModule();
  } else if (isBrowser) {
    module = new IndexedDBModule();
  } else {
    throw new QuereusError(
      'quereus-plugin-store: Unable to detect platform. Use LevelDBModule (Node.js) or IndexedDBModule (browser) directly.',
      StatusCode.ERROR
    );
  }

  return {
    vtables: [
      { name: moduleName, module },
    ],
  };
}

