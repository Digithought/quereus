/**
 * Sync Plugin for Quereus
 *
 * Provides multi-master CRDT replication with automatic conflict resolution.
 *
 * Features:
 * - Fully automatic: All tables are CRDT-enabled without opt-in
 * - Column-level LWW: Fine-grained conflict resolution
 * - Transport agnostic: Bring your own WebSocket/HTTP/WebRTC
 * - Reactive hooks: UI integration for real-time updates
 * - Offline-first: Works with local changes that sync later
 *
 * Usage:
 *   import { createSyncModule } from 'quereus-plugin-sync';
 *   import { LevelDBModule, StoreEventEmitter } from 'quereus-plugin-store';
 *
 *   const storeEvents = new StoreEventEmitter();
 *   const store = new LevelDBModule(storeEvents);
 *   const { syncModule, syncManager, syncEvents } = createSyncModule(store, storeEvents);
 *
 *   db.registerVtabModule('store', syncModule);
 */

// Clock module
export {
  // HLC types and functions
  type HLC,
  HLCManager,
  compareHLC,
  hlcEquals,
  createHLC,
  serializeHLC,
  deserializeHLC,
  // Site ID types and functions
  type SiteId,
  generateSiteId,
  siteIdToHex,
  siteIdFromHex,
  siteIdToUUID,
  siteIdFromUUID,
  siteIdEquals,
  type SiteIdentity,
  serializeSiteIdentity,
  deserializeSiteIdentity,
  SITE_ID_KEY,
} from './clock/index.js';

// Sync protocol types
export {
  // Change types
  type ColumnChange,
  type RowDeletion,
  type Change,
  // Schema types
  type SchemaMigrationType,
  type SchemaMigration,
  // Transaction types
  type ChangeSet,
  // API types
  type ApplyResult,
  type ColumnVersionEntry,
  type TableSnapshot,
  type Snapshot,
  type PeerSyncState,
  // Streaming snapshot types
  type SnapshotChunkType,
  type SnapshotHeaderChunk,
  type SnapshotTableStartChunk,
  type SnapshotColumnVersionsChunk,
  type SnapshotTableEndChunk,
  type SnapshotSchemaMigrationChunk,
  type SnapshotFooterChunk,
  type SnapshotChunk,
  type SnapshotProgress,
  // Apply-to-store callback types
  type ApplyToStoreOptions,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type ApplyToStoreResult,
  type ApplyToStoreCallback,
  // Configuration
  type SyncConfig,
  DEFAULT_SYNC_CONFIG,
} from './sync/protocol.js';

// Sync manager
export { type SyncManager, type SnapshotCheckpoint } from './sync/manager.js';
export { SyncManagerImpl } from './sync/sync-manager-impl.js';

// Factory function
export {
  createSyncModule,
  type CreateSyncModuleResult,
  type CreateSyncModuleOptions,
} from './create-sync-module.js';

// Reactive events
export {
  type RemoteChangeEvent,
  type LocalChangeEvent,
  type ConflictEvent,
  type SyncState,
  type Unsubscribe,
  type SyncEventEmitter,
  SyncEventEmitterImpl,
} from './sync/events.js';

// Metadata storage
export {
  // Key builders
  SYNC_KEY_PREFIX,
  buildColumnVersionKey,
  buildTombstoneKey,
  buildTransactionKey,
  buildPeerStateKey,
  buildSchemaMigrationKey,
  buildColumnVersionScanBounds,
  buildTombstoneScanBounds,
  buildSchemaMigrationScanBounds,
  encodePK,
  decodePK,
  // Column versions
  type ColumnVersion,
  ColumnVersionStore,
  serializeColumnVersion,
  deserializeColumnVersion,
  // Tombstones
  type Tombstone,
  TombstoneStore,
  serializeTombstone,
  deserializeTombstone,
  // Peer state
  type PeerState,
  PeerStateStore,
  serializePeerState,
  deserializePeerState,
} from './metadata/index.js';

