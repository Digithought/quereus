/**
 * Common utilities for the persistent store module.
 */

// KV Store interface
export type {
  KVStore,
  KVEntry,
  WriteBatch,
  BatchOp,
  IterateOptions,
  KVStoreFactory,
  KVStoreOptions,
  KVStoreProvider,
} from './kv-store.js';

// Key encoding
export {
  encodeValue,
  encodeCompositeKey,
  decodeValue,
  decodeCompositeKey,
  registerCollationEncoder,
  getCollationEncoder,
  type CollationEncoder,
  type EncodeOptions,
} from './encoding.js';

// Row serialization
export {
  serializeRow,
  deserializeRow,
  serializeValue,
  deserializeValue,
  serializeStats,
  deserializeStats,
  type TableStats,
} from './serialization.js';

// Key building
export {
  KEY_PREFIX,
  buildDataKey,
  buildIndexKey,
  buildMetaKey,
  buildTablePrefix,
  buildTableScanBounds,
  buildIndexScanBounds,
  buildMetaScanBounds,
} from './key-builder.js';

// Events
export {
  StoreEventEmitter,
  type SchemaChangeEvent,
  type DataChangeEvent,
  type SchemaChangeListener,
  type DataChangeListener,
} from './events.js';

// DDL generation
export {
  generateTableDDL,
  generateIndexDDL,
} from './ddl-generator.js';

// Transaction support
export {
  TransactionCoordinator,
  type TransactionCallbacks,
} from './transaction.js';

// In-memory KV store
export { InMemoryKVStore } from './memory-store.js';

// Generic store table and connection
export {
  StoreTable,
  type StoreTableConfig,
  type StoreTableModule,
} from './store-table.js';
export { StoreConnection } from './store-connection.js';
