/**
 * Factory function to create a sync-enabled store module.
 *
 * This wraps an existing store module (LevelDB or IndexedDB) with
 * CRDT sync capabilities.
 */

import type { KVStore, StoreEventEmitter } from 'quereus-plugin-store';
import { SyncManagerImpl } from './sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from './sync/events.js';
import { DEFAULT_SYNC_CONFIG, type SyncConfig, type ApplyToStoreCallback } from './sync/protocol.js';
import type { SyncManager } from './sync/manager.js';

/**
 * Result of creating a sync module.
 */
export interface CreateSyncModuleResult {
  /** The sync manager for sync operations */
  syncManager: SyncManager;
  /** Event emitter for reactive UI integration */
  syncEvents: SyncEventEmitterImpl;
}

/**
 * Options for creating a sync module.
 */
export interface CreateSyncModuleOptions extends Partial<SyncConfig> {
  /**
   * Callback for applying remote changes to the store.
   *
   * When provided, the SyncManager will call this to apply data and schema
   * changes from remote replicas. The store should emit events with
   * `remote: true` when this is called.
   *
   * If not provided, the SyncManager will only update CRDT metadata
   * and emit sync events, but will not modify actual data. The application
   * is responsible for applying changes separately.
   */
  applyToStore?: ApplyToStoreCallback;
}

/**
 * Create a sync-enabled module.
 *
 * This function:
 * 1. Creates a SyncManager that tracks CRDT metadata
 * 2. Subscribes to store events to record changes
 * 3. Returns the sync manager and event emitter for UI integration
 *
 * @param kv - The KV store to use for metadata storage
 * @param storeEvents - The store's event emitter
 * @param config - Optional sync configuration
 *
 * @example
 * ```typescript
 * import { LevelDBStore, StoreEventEmitter } from 'quereus-plugin-store';
 * import { createSyncModule } from 'quereus-plugin-sync';
 *
 * const storeEvents = new StoreEventEmitter();
 * const kv = await LevelDBStore.open({ path: './data' });
 *
 * const { syncManager, syncEvents } = await createSyncModule(kv, storeEvents);
 *
 * // Subscribe to sync events for UI
 * syncEvents.onRemoteChange((event) => {
 *   console.log('Remote changes:', event.changes.length);
 * });
 *
 * // Use syncManager for sync operations
 * const changes = await syncManager.getChangesSince(peerSiteId, lastHLC);
 * ```
 */
export async function createSyncModule(
  kv: KVStore,
  storeEvents: StoreEventEmitter,
  options: CreateSyncModuleOptions = {}
): Promise<CreateSyncModuleResult> {
  const { applyToStore, ...configOverrides } = options;

  const fullConfig: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    ...configOverrides,
  };

  const syncEvents = new SyncEventEmitterImpl();

  const syncManager = await SyncManagerImpl.create(
    kv,
    storeEvents,
    fullConfig,
    syncEvents,
    applyToStore
  );

  return {
    syncManager,
    syncEvents,
  };
}

