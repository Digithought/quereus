/**
 * SyncManager implementation.
 *
 * Coordinates CRDT metadata tracking and sync operations.
 */

import type { KVStore, StoreEventEmitter, DataChangeEvent } from 'quereus-plugin-store';
import type { SqlValue, Row } from '@quereus/quereus';
import { HLCManager, type HLC, compareHLC } from '../clock/hlc.js';
import {
  generateSiteId,
  type SiteId,
  SITE_ID_KEY,
  serializeSiteIdentity,
  deserializeSiteIdentity,
} from '../clock/site.js';
import { ColumnVersionStore, type ColumnVersion } from '../metadata/column-version.js';
import { TombstoneStore } from '../metadata/tombstones.js';
import { PeerStateStore } from '../metadata/peer-state.js';
import { SYNC_KEY_PREFIX } from '../metadata/keys.js';
import type { SyncManager } from './manager.js';
import type {
  SyncConfig,
  ChangeSet,
  Change,
  ColumnChange,
  RowDeletion,
  ApplyResult,
  Snapshot,
} from './protocol.js';
import { SyncEventEmitterImpl, type ConflictEvent } from './events.js';

/**
 * Implementation of SyncManager.
 */
export class SyncManagerImpl implements SyncManager {
  private readonly kv: KVStore;
  private readonly config: SyncConfig;
  private readonly hlcManager: HLCManager;
  private readonly columnVersions: ColumnVersionStore;
  private readonly tombstones: TombstoneStore;
  private readonly peerStates: PeerStateStore;
  private readonly syncEvents: SyncEventEmitterImpl;

  // Pending changes for the current transaction
  private pendingChanges: Change[] = [];
  private currentTransactionId: string | null = null;

  private constructor(
    kv: KVStore,
    config: SyncConfig,
    hlcManager: HLCManager,
    syncEvents: SyncEventEmitterImpl
  ) {
    this.kv = kv;
    this.config = config;
    this.hlcManager = hlcManager;
    this.syncEvents = syncEvents;
    this.columnVersions = new ColumnVersionStore(kv);
    this.tombstones = new TombstoneStore(kv, config.tombstoneTTL);
    this.peerStates = new PeerStateStore(kv);
  }

  /**
   * Create a new SyncManager, initializing or loading site identity.
   */
  static async create(
    kv: KVStore,
    storeEvents: StoreEventEmitter,
    config: SyncConfig,
    syncEvents: SyncEventEmitterImpl
  ): Promise<SyncManagerImpl> {
    // Load or create site identity
    const siteIdKey = new TextEncoder().encode(SITE_ID_KEY);
    let siteId: SiteId;

    const existingIdentity = await kv.get(siteIdKey);
    if (existingIdentity) {
      const identity = deserializeSiteIdentity(existingIdentity);
      siteId = identity.siteId;
    } else if (config.siteId) {
      siteId = config.siteId;
      await kv.put(siteIdKey, serializeSiteIdentity({ siteId, createdAt: Date.now() }));
    } else {
      siteId = generateSiteId();
      await kv.put(siteIdKey, serializeSiteIdentity({ siteId, createdAt: Date.now() }));
    }

    // Load HLC state
    const hlcKey = SYNC_KEY_PREFIX.HLC_STATE;
    const hlcData = await kv.get(hlcKey);
    let hlcState: { wallTime: bigint; counter: number } | undefined;
    if (hlcData) {
      const view = new DataView(hlcData.buffer, hlcData.byteOffset, hlcData.byteLength);
      hlcState = {
        wallTime: view.getBigUint64(0, false),
        counter: view.getUint16(8, false),
      };
    }

    const hlcManager = new HLCManager(siteId, hlcState);
    const manager = new SyncManagerImpl(kv, config, hlcManager, syncEvents);

    // Subscribe to store events
    storeEvents.onDataChange((event) => manager.handleDataChange(event));

    return manager;
  }

  getSiteId(): SiteId {
    return this.hlcManager.getSiteId();
  }

  getCurrentHLC(): HLC {
    return this.hlcManager.now();
  }

  /**
   * Handle a data change event from the store.
   * Records CRDT metadata for the change.
   */
  private async handleDataChange(event: DataChangeEvent): Promise<void> {
    const hlc = this.hlcManager.tick();
    const { schemaName, tableName, key: pk, type, oldRow, newRow } = event;

    if (type === 'delete') {
      // Record tombstone
      await this.tombstones.setTombstone(schemaName, tableName, pk, hlc);

      // Delete column versions for this row
      await this.columnVersions.deleteRowVersions(schemaName, tableName, pk);

      const change: RowDeletion = {
        type: 'delete',
        schema: schemaName,
        table: tableName,
        pk,
        hlc,
      };
      this.pendingChanges.push(change);
    } else {
      // Insert or update: record column versions
      if (newRow) {
        await this.recordColumnVersions(schemaName, tableName, pk, oldRow, newRow, hlc);
      }
    }

    // Persist HLC state
    await this.persistHLCState();

    // Emit local change event
    this.syncEvents.emitLocalChange({
      transactionId: this.currentTransactionId || crypto.randomUUID(),
      changes: [...this.pendingChanges],
      pendingSync: true,
    });
  }

  private async recordColumnVersions(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    oldRow: Row | undefined,
    newRow: Row,
    hlc: HLC
  ): Promise<void> {
    // For each column that changed, record the new version
    for (let i = 0; i < newRow.length; i++) {
      const oldValue = oldRow?.[i];
      const newValue = newRow[i];

      // Only record if value changed (or it's an insert)
      if (!oldRow || oldValue !== newValue) {
        // We need column names - for now use index as placeholder
        // In real implementation, we'd get column names from schema
        const column = `col_${i}`;
        const version: ColumnVersion = { hlc, value: newValue };
        await this.columnVersions.setColumnVersion(schemaName, tableName, pk, column, version);

        const change: ColumnChange = {
          type: 'column',
          schema: schemaName,
          table: tableName,
          pk,
          column,
          value: newValue,
          hlc,
        };
        this.pendingChanges.push(change);
      }
    }
  }

  private async persistHLCState(): Promise<void> {
    const state = this.hlcManager.getState();
    const buffer = new Uint8Array(10);
    const view = new DataView(buffer.buffer);
    view.setBigUint64(0, state.wallTime, false);
    view.setUint16(8, state.counter, false);
    await this.kv.put(SYNC_KEY_PREFIX.HLC_STATE, buffer);
  }

  async getChangesSince(_peerSiteId: SiteId, _sinceHLC?: HLC): Promise<ChangeSet[]> {
    // TODO: Implement change extraction from metadata
    // For now, return empty array
    return [];
  }

  async applyChanges(changes: ChangeSet[]): Promise<ApplyResult> {
    let applied = 0;
    let skipped = 0;
    let conflicts = 0;

    for (const changeSet of changes) {
      // Update our clock with the remote HLC
      this.hlcManager.receive(changeSet.hlc);

      for (const change of changeSet.changes) {
        const result = await this.applyChange(change, changeSet.siteId);
        if (result === 'applied') applied++;
        else if (result === 'skipped') skipped++;
        else if (result === 'conflict') conflicts++;
      }
    }

    await this.persistHLCState();

    return {
      applied,
      skipped,
      conflicts,
      transactions: changes.length,
    };
  }

  private async applyChange(
    change: Change,
    remoteSiteId: SiteId
  ): Promise<'applied' | 'skipped' | 'conflict'> {
    if (change.type === 'delete') {
      // Check if we should apply this deletion
      const existingTombstone = await this.tombstones.getTombstone(
        change.schema,
        change.table,
        change.pk
      );

      if (existingTombstone && compareHLC(change.hlc, existingTombstone.hlc) <= 0) {
        return 'skipped';
      }

      // Apply the deletion
      await this.tombstones.setTombstone(change.schema, change.table, change.pk, change.hlc);
      await this.columnVersions.deleteRowVersions(change.schema, change.table, change.pk);

      this.syncEvents.emitRemoteChange({
        siteId: remoteSiteId,
        transactionId: crypto.randomUUID(),
        changes: [change],
        appliedAt: this.hlcManager.now(),
      });

      return 'applied';
    } else {
      // Column change
      const shouldApply = await this.columnVersions.shouldApplyWrite(
        change.schema,
        change.table,
        change.pk,
        change.column,
        change.hlc
      );

      if (!shouldApply) {
        // Local version is newer - this is a conflict where local wins
        const localVersion = await this.columnVersions.getColumnVersion(
          change.schema,
          change.table,
          change.pk,
          change.column
        );

        if (localVersion) {
          const conflictEvent: ConflictEvent = {
            table: change.table,
            pk: change.pk,
            column: change.column,
            localValue: localVersion.value,
            remoteValue: change.value,
            winner: 'local',
            winningHLC: localVersion.hlc,
          };
          this.syncEvents.emitConflictResolved(conflictEvent);
        }

        return 'conflict';
      }

      // Check for tombstone blocking
      const isBlocked = await this.tombstones.isDeletedAndBlocking(
        change.schema,
        change.table,
        change.pk,
        change.hlc,
        this.config.allowResurrection
      );

      if (isBlocked) {
        return 'skipped';
      }

      // Apply the column change
      await this.columnVersions.setColumnVersion(
        change.schema,
        change.table,
        change.pk,
        change.column,
        { hlc: change.hlc, value: change.value }
      );

      this.syncEvents.emitRemoteChange({
        siteId: remoteSiteId,
        transactionId: crypto.randomUUID(),
        changes: [change],
        appliedAt: this.hlcManager.now(),
      });

      return 'applied';
    }
  }

  async canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean> {
    const peerState = await this.peerStates.getPeerState(peerSiteId);
    if (!peerState) {
      // Never synced with this peer - need full snapshot
      return false;
    }

    // Check if the sinceHLC is within tombstone TTL
    const now = Date.now();
    const sinceTime = Number(sinceHLC.wallTime);
    if (now - sinceTime > this.config.tombstoneTTL) {
      // Too old - tombstones may have been pruned
      return false;
    }

    return true;
  }

  async getSnapshot(): Promise<Snapshot> {
    // TODO: Implement full snapshot extraction
    return {
      siteId: this.getSiteId(),
      hlc: this.getCurrentHLC(),
      tables: [],
      schemaMigrations: [],
    };
  }

  async applySnapshot(_snapshot: Snapshot): Promise<void> {
    // TODO: Implement full snapshot application
  }

  async updatePeerSyncState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
    await this.peerStates.setPeerState(peerSiteId, hlc);
  }

  async getPeerSyncState(peerSiteId: SiteId): Promise<HLC | undefined> {
    const state = await this.peerStates.getPeerState(peerSiteId);
    return state?.lastSyncHLC;
  }

  async pruneTombstones(): Promise<number> {
    // TODO: Iterate over all tables and prune tombstones
    return 0;
  }

  /**
   * Get the sync event emitter for UI integration.
   */
  getEventEmitter(): SyncEventEmitterImpl {
    return this.syncEvents;
  }
}

