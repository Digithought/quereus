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
} from './kv-store.js';

// Key encoding
export {
  encodeValue,
  encodeCompositeKey,
  decodeValue,
  decodeCompositeKey,
  type KeyCollation,
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

