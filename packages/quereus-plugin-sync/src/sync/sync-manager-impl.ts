/**
 * SyncManager implementation.
 *
 * Coordinates CRDT metadata tracking and sync operations.
 */

import type { KVStore, StoreEventEmitter, DataChangeEvent, SchemaChangeEvent } from 'quereus-plugin-store';
import type { SqlValue, Row, TableSchema } from '@quereus/quereus';

/**
 * Callback to get table schema by name.
 * Used to map column indices to actual column names.
 */
export type GetTableSchemaCallback = (schemaName: string, tableName: string) => TableSchema | undefined;
import { HLCManager, type HLC, compareHLC } from '../clock/hlc.js';
import {
  generateSiteId,
  type SiteId,
  SITE_ID_KEY,
  serializeSiteIdentity,
  deserializeSiteIdentity,
  siteIdEquals,
} from '../clock/site.js';
import { ColumnVersionStore, type ColumnVersion, deserializeColumnVersion } from '../metadata/column-version.js';
import { TombstoneStore, deserializeTombstone } from '../metadata/tombstones.js';
import { PeerStateStore } from '../metadata/peer-state.js';
import { SchemaMigrationStore, deserializeMigration } from '../metadata/schema-migration.js';
import { ChangeLogStore } from '../metadata/change-log.js';
import {
  SYNC_KEY_PREFIX,
  buildAllColumnVersionsScanBounds,
  buildAllTombstonesScanBounds,
  buildAllSchemaMigrationsScanBounds,
  buildAllChangeLogScanBounds,
  parseColumnVersionKey,
  parseTombstoneKey,
  parseSchemaMigrationKey,
  encodePK,
} from '../metadata/keys.js';
import type { SyncManager, SnapshotCheckpoint } from './manager.js';
import type {
  SyncConfig,
  ChangeSet,
  Change,
  ColumnChange,
  RowDeletion,
  ApplyResult,
  Snapshot,
  SchemaMigration,
  SchemaMigrationType,
  TableSnapshot,
  SnapshotChunk,
  SnapshotProgress,
  SnapshotHeaderChunk,
  SnapshotTableStartChunk,
  SnapshotColumnVersionsChunk,
  SnapshotTableEndChunk,
  SnapshotSchemaMigrationChunk,
  SnapshotFooterChunk,
  ApplyToStoreCallback,
  DataChangeToApply,
  SchemaChangeToApply,
} from './protocol.js';
import { SyncEventEmitterImpl, type ConflictEvent } from './events.js';

/** Default chunk size for streaming snapshots. */
const DEFAULT_SNAPSHOT_CHUNK_SIZE = 1000;

/** Key prefix for snapshot checkpoints. */
const CHECKPOINT_PREFIX = 'sc:';

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
  private readonly changeLog: ChangeLogStore;
  private readonly schemaMigrations: SchemaMigrationStore;
  private readonly syncEvents: SyncEventEmitterImpl;
  private readonly applyToStore?: ApplyToStoreCallback;
  private readonly getTableSchema?: GetTableSchemaCallback;

  // Pending changes for the current transaction
  private pendingChanges: Change[] = [];
  private currentTransactionId: string | null = null;

  private constructor(
    kv: KVStore,
    config: SyncConfig,
    hlcManager: HLCManager,
    syncEvents: SyncEventEmitterImpl,
    applyToStore?: ApplyToStoreCallback,
    getTableSchema?: GetTableSchemaCallback
  ) {
    this.kv = kv;
    this.config = config;
    this.hlcManager = hlcManager;
    this.syncEvents = syncEvents;
    this.applyToStore = applyToStore;
    this.getTableSchema = getTableSchema;
    this.columnVersions = new ColumnVersionStore(kv);
    this.tombstones = new TombstoneStore(kv, config.tombstoneTTL);
    this.peerStates = new PeerStateStore(kv);
    this.changeLog = new ChangeLogStore(kv);
    this.schemaMigrations = new SchemaMigrationStore(kv);
  }

  /**
   * Create a new SyncManager, initializing or loading site identity.
   *
   * @param kv - KV store for sync metadata
   * @param storeEvents - Store event emitter to subscribe to local changes
   * @param config - Sync configuration
   * @param syncEvents - Sync event emitter for UI integration
   * @param applyToStore - Optional callback for applying remote changes to the store
   * @param getTableSchema - Optional callback for getting table schema by name
   */
  static async create(
    kv: KVStore,
    storeEvents: StoreEventEmitter,
    config: SyncConfig,
    syncEvents: SyncEventEmitterImpl,
    applyToStore?: ApplyToStoreCallback,
    getTableSchema?: GetTableSchemaCallback
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
    const manager = new SyncManagerImpl(kv, config, hlcManager, syncEvents, applyToStore, getTableSchema);

    // Subscribe to store events
    storeEvents.onDataChange((event) => manager.handleDataChange(event));
    storeEvents.onSchemaChange((event) => manager.handleSchemaChange(event));

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
   * Skips remote events to prevent duplicate recording.
   */
  private async handleDataChange(event: DataChangeEvent): Promise<void> {
    // Skip events from remote sync - metadata already recorded by the originating replica
    if (event.remote) return;

    const hlc = this.hlcManager.tick();
    const { schemaName, tableName, type, oldRow, newRow } = event;
    // Support both 'key' and 'pk' property names
    const pk = event.key ?? event.pk;
    if (!pk) {
      // Cannot record change without primary key
      return;
    }
    const batch = this.kv.batch();

    if (type === 'delete') {
      // Record tombstone
      this.tombstones.setTombstoneBatch(batch, schemaName, tableName, pk, hlc);

      // Record in change log for efficient delta queries
      this.changeLog.recordDeletionBatch(batch, hlc, schemaName, tableName, pk);

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
        await this.recordColumnVersions(batch, schemaName, tableName, pk, oldRow, newRow, hlc);
      }
    }

    // Persist HLC state in batch
    const hlcState = this.hlcManager.getState();
    const hlcBuffer = new Uint8Array(10);
    const hlcView = new DataView(hlcBuffer.buffer);
    hlcView.setBigUint64(0, hlcState.wallTime, false);
    hlcView.setUint16(8, hlcState.counter, false);
    batch.put(SYNC_KEY_PREFIX.HLC_STATE, hlcBuffer);

    await batch.write();

    // Emit local change event
    this.syncEvents.emitLocalChange({
      transactionId: this.currentTransactionId || crypto.randomUUID(),
      changes: [...this.pendingChanges],
      pendingSync: true,
    });
  }

  /**
   * Handle a schema change event from the store.
   * Records schema migrations for sync.
   * Skips remote events to prevent duplicate recording.
   */
  private async handleSchemaChange(event: SchemaChangeEvent): Promise<void> {
    // Skip events from remote sync - metadata already recorded by the originating replica
    if (event.remote) return;

    const hlc = this.hlcManager.tick();
    const { type, objectType, schemaName, objectName, ddl } = event;

    // Map store event type to migration type
    let migrationType: SchemaMigrationType;
    if (objectType === 'table') {
      switch (type) {
        case 'create': migrationType = 'create_table'; break;
        case 'drop': migrationType = 'drop_table'; break;
        case 'alter': migrationType = 'alter_column'; break;
        default: return; // Unknown type
      }
    } else if (objectType === 'index') {
      switch (type) {
        case 'create': migrationType = 'add_index'; break;
        case 'drop': migrationType = 'drop_index'; break;
        default: return; // Unknown type
      }
    } else {
      return; // Unknown object type
    }

    // Get next schema version for this table
    const currentVersion = await this.schemaMigrations.getCurrentVersion(schemaName, objectName);
    const newVersion = currentVersion + 1;

    // Record the migration
    await this.schemaMigrations.recordMigration(schemaName, objectName, {
      type: migrationType,
      ddl: ddl || '',
      hlc,
      schemaVersion: newVersion,
    });

    // Persist HLC state
    const hlcState = this.hlcManager.getState();
    const hlcBuffer = new Uint8Array(10);
    const hlcView = new DataView(hlcBuffer.buffer);
    hlcView.setBigUint64(0, hlcState.wallTime, false);
    hlcView.setUint16(8, hlcState.counter, false);
    await this.kv.put(SYNC_KEY_PREFIX.HLC_STATE, hlcBuffer);

    // Emit local change event for the schema migration
    this.syncEvents.emitLocalChange({
      transactionId: crypto.randomUUID(),
      changes: [],
      pendingSync: true,
    });
  }

  private async recordColumnVersions(
    batch: import('quereus-plugin-store').WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    oldRow: Row | undefined,
    newRow: Row,
    hlc: HLC
  ): Promise<void> {
    // Try to get actual column names from schema
    const tableSchema = this.getTableSchema?.(schemaName, tableName);
    const columnNames = tableSchema?.columns?.map(c => c.name);

    // Debug logging for column name resolution
    if (!tableSchema) {
      console.warn(`[Sync] No table schema found for ${schemaName}.${tableName} - using fallback column names`);
    }

    // For each column that changed, record the new version
    for (let i = 0; i < newRow.length; i++) {
      const oldValue = oldRow?.[i];
      const newValue = newRow[i];

      // Only record if value changed (or it's an insert)
      if (!oldRow || oldValue !== newValue) {
        // Use actual column name if available, otherwise fall back to index-based
        const column = columnNames?.[i] ?? `col_${i}`;
        const version: ColumnVersion = { hlc, value: newValue };
        this.columnVersions.setColumnVersionBatch(batch, schemaName, tableName, pk, column, version);

        // Record in change log for efficient delta queries
        this.changeLog.recordColumnChangeBatch(batch, hlc, schemaName, tableName, pk, column);

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

  async getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]> {
    const changes: Change[] = [];

    if (sinceHLC) {
      // Use change log for efficient delta query
      for await (const logEntry of this.changeLog.getChangesSince(sinceHLC)) {
        // Don't include changes from the requesting peer
        if (siteIdEquals(logEntry.hlc.siteId, peerSiteId)) continue;

        if (logEntry.entryType === 'column') {
          // Look up the column version to get the value
          const cv = await this.columnVersions.getColumnVersion(
            logEntry.schema,
            logEntry.table,
            logEntry.pk,
            logEntry.column!
          );
          if (!cv) continue; // May have been superseded

          const columnChange: ColumnChange = {
            type: 'column',
            schema: logEntry.schema,
            table: logEntry.table,
            pk: logEntry.pk,
            column: logEntry.column!,
            value: cv.value,
            hlc: cv.hlc,
          };
          changes.push(columnChange);
        } else {
          // Look up tombstone for the deletion
          const tombstone = await this.tombstones.getTombstone(
            logEntry.schema,
            logEntry.table,
            logEntry.pk
          );
          if (!tombstone) continue; // May have been pruned

          const deletion: RowDeletion = {
            type: 'delete',
            schema: logEntry.schema,
            table: logEntry.table,
            pk: logEntry.pk,
            hlc: tombstone.hlc,
          };
          changes.push(deletion);
        }
      }
    } else {
      // No sinceHLC - need all changes (full scan fallback)
      await this.collectAllChanges(peerSiteId, changes);
    }

    // Collect schema migrations since sinceHLC
    const schemaMigrations: SchemaMigration[] = [];
    const smBounds = buildAllSchemaMigrationsScanBounds();
    for await (const entry of this.kv.iterate(smBounds)) {
      const parsed = parseSchemaMigrationKey(entry.key);
      if (!parsed) continue;

      const migration = deserializeMigration(entry.value);

      // Filter by HLC if provided
      if (sinceHLC && compareHLC(migration.hlc, sinceHLC) <= 0) continue;

      // Don't include changes from the requesting peer
      if (siteIdEquals(migration.hlc.siteId, peerSiteId)) continue;

      schemaMigrations.push({
        type: migration.type,
        schema: parsed.schema,
        table: parsed.table,
        ddl: migration.ddl,
        hlc: migration.hlc,
        schemaVersion: migration.schemaVersion,
      });
    }

    // If no changes, return empty array
    if (changes.length === 0 && schemaMigrations.length === 0) {
      return [];
    }

    // Changes from change log are already in HLC order
    // Schema migrations need sorting
    schemaMigrations.sort((a, b) => compareHLC(a.hlc, b.hlc));

    // Batch changes up to config.batchSize
    const result: ChangeSet[] = [];
    for (let i = 0; i < changes.length; i += this.config.batchSize) {
      const batch = changes.slice(i, i + this.config.batchSize);
      const maxHLC = batch.reduce((max, c) => compareHLC(c.hlc, max) > 0 ? c.hlc : max, batch[0].hlc);

      result.push({
        siteId: this.getSiteId(),
        transactionId: crypto.randomUUID(),
        hlc: maxHLC,
        changes: batch,
        schemaMigrations: i === 0 ? schemaMigrations : [], // Only include schema migrations in first batch
      });
    }

    // If no data changes but we have schema migrations, create a changeset for them
    if (result.length === 0 && schemaMigrations.length > 0) {
      const maxHLC = schemaMigrations.reduce(
        (max, m) => compareHLC(m.hlc, max) > 0 ? m.hlc : max,
        schemaMigrations[0].hlc
      );
      result.push({
        siteId: this.getSiteId(),
        transactionId: crypto.randomUUID(),
        hlc: maxHLC,
        changes: [],
        schemaMigrations,
      });
    }

    return result;
  }

  /**
   * Fallback: collect all changes when no sinceHLC is provided.
   */
  private async collectAllChanges(peerSiteId: SiteId, changes: Change[]): Promise<void> {
    // Collect all column changes
    const cvBounds = buildAllColumnVersionsScanBounds();
    for await (const entry of this.kv.iterate(cvBounds)) {
      const parsed = parseColumnVersionKey(entry.key);
      if (!parsed) continue;

      const cv = deserializeColumnVersion(entry.value);

      // Don't include changes from the requesting peer
      if (siteIdEquals(cv.hlc.siteId, peerSiteId)) continue;

      const columnChange: ColumnChange = {
        type: 'column',
        schema: parsed.schema,
        table: parsed.table,
        pk: parsed.pk,
        column: parsed.column,
        value: cv.value,
        hlc: cv.hlc,
      };
      changes.push(columnChange);
    }

    // Collect all deletions (tombstones)
    const tbBounds = buildAllTombstonesScanBounds();
    for await (const entry of this.kv.iterate(tbBounds)) {
      const parsed = parseTombstoneKey(entry.key);
      if (!parsed) continue;

      const tombstone = deserializeTombstone(entry.value);

      // Don't include changes from the requesting peer
      if (siteIdEquals(tombstone.hlc.siteId, peerSiteId)) continue;

      const deletion: RowDeletion = {
        type: 'delete',
        schema: parsed.schema,
        table: parsed.table,
        pk: parsed.pk,
        hlc: tombstone.hlc,
      };
      changes.push(deletion);
    }

    // Sort by HLC for consistent ordering
    changes.sort((a, b) => compareHLC(a.hlc, b.hlc));
  }

  async applyChanges(changes: ChangeSet[]): Promise<ApplyResult> {
    let applied = 0;
    let skipped = 0;
    let conflicts = 0;

    // Collect changes to apply to the store (grouped by row for column merging)
    const dataChangesToApply: DataChangeToApply[] = [];
    const schemaChangesToApply: SchemaChangeToApply[] = [];
    const appliedChanges: Array<{ change: Change; siteId: SiteId }> = [];

    for (const changeSet of changes) {
      // Update our clock with the remote HLC
      this.hlcManager.receive(changeSet.hlc);

      // Process schema migrations first (DDL before DML)
      for (const migration of changeSet.schemaMigrations) {
        // Record the migration in our metadata store so we can forward it to other peers
        // Use the incoming schemaVersion if provided, otherwise calculate next version
        const schemaVersion = migration.schemaVersion ??
          (await this.schemaMigrations.getCurrentVersion(migration.schema, migration.table)) + 1;

        await this.schemaMigrations.recordMigration(migration.schema, migration.table, {
          type: migration.type,
          ddl: migration.ddl,
          hlc: migration.hlc,
          schemaVersion,
        });

        schemaChangesToApply.push({
          type: migration.type,
          schema: migration.schema,
          table: migration.table,
          ddl: migration.ddl,
        });
        // Count schema migrations as applied changes
        applied++;
      }

      // Process data changes
      for (const change of changeSet.changes) {
        const result = await this.resolveAndRecordChange(change, changeSet.siteId);
        if (result.outcome === 'applied') {
          applied++;
          appliedChanges.push({ change, siteId: changeSet.siteId });
          if (result.dataChange) {
            dataChangesToApply.push(result.dataChange);
          }
        } else if (result.outcome === 'skipped') {
          skipped++;
        } else if (result.outcome === 'conflict') {
          conflicts++;
        }
      }
    }

    // Apply data and schema changes to the store via callback
    if (this.applyToStore && (dataChangesToApply.length > 0 || schemaChangesToApply.length > 0)) {
      await this.applyToStore(dataChangesToApply, schemaChangesToApply, { remote: true });
    }

    // Emit remote change events for UI reactivity
    for (const { change, siteId } of appliedChanges) {
      this.syncEvents.emitRemoteChange({
        siteId,
        transactionId: crypto.randomUUID(),
        changes: [change],
        appliedAt: this.hlcManager.now(),
      });
    }

    await this.persistHLCState();

    return {
      applied,
      skipped,
      conflicts,
      transactions: changes.length,
    };
  }

  /**
   * Resolve CRDT conflicts and record metadata for a change.
   * Returns outcome and the data change to apply (if any).
   */
  private async resolveAndRecordChange(
    change: Change,
    _remoteSiteId: SiteId
  ): Promise<{
    outcome: 'applied' | 'skipped' | 'conflict';
    dataChange?: DataChangeToApply;
  }> {
    if (change.type === 'delete') {
      // Check if we should apply this deletion
      const existingTombstone = await this.tombstones.getTombstone(
        change.schema,
        change.table,
        change.pk
      );

      if (existingTombstone && compareHLC(change.hlc, existingTombstone.hlc) <= 0) {
        return { outcome: 'skipped' };
      }

      // Record the tombstone and delete column versions (metadata update)
      await this.tombstones.setTombstone(change.schema, change.table, change.pk, change.hlc);
      await this.columnVersions.deleteRowVersions(change.schema, change.table, change.pk);

      // Return the data change for the store
      return {
        outcome: 'applied',
        dataChange: {
          type: 'delete',
          schema: change.schema,
          table: change.table,
          pk: change.pk,
        },
      };
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

        return { outcome: 'conflict' };
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
        return { outcome: 'skipped' };
      }

      // Record the column version (metadata update)
      await this.columnVersions.setColumnVersion(
        change.schema,
        change.table,
        change.pk,
        change.column,
        { hlc: change.hlc, value: change.value }
      );

      // Return the data change for the store
      return {
        outcome: 'applied',
        dataChange: {
          type: 'update',  // Column changes are updates (or inserts handled by store)
          schema: change.schema,
          table: change.table,
          pk: change.pk,
          columns: { [change.column]: change.value },
        },
      };
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
    // Collect all column versions, grouped by table and row
    // Map: tableKey -> rowKey -> columnName -> ColumnVersion
    type RowVersions = Map<string, ColumnVersion>;
    type TableRows = Map<string, RowVersions>;
    const tableData = new Map<string, TableRows>();

    const cvBounds = buildAllColumnVersionsScanBounds();
    for await (const entry of this.kv.iterate(cvBounds)) {
      const parsed = parseColumnVersionKey(entry.key);
      if (!parsed) continue;

      const cv = deserializeColumnVersion(entry.value);
      const tableKey = `${parsed.schema}.${parsed.table}`;
      const rowKey = encodePK(parsed.pk);

      if (!tableData.has(tableKey)) {
        tableData.set(tableKey, new Map());
      }
      const tableRows = tableData.get(tableKey)!;

      if (!tableRows.has(rowKey)) {
        tableRows.set(rowKey, new Map());
      }
      const rowVersions = tableRows.get(rowKey)!;
      rowVersions.set(parsed.column, cv);
    }

    // Build table snapshots
    const tables: TableSnapshot[] = [];
    for (const [tableKey, rows] of tableData) {
      const [schema, table] = tableKey.split('.');
      const columnVersions = new Map<string, { hlc: HLC; value: SqlValue }>();
      const rowsArray: Row[] = [];

      for (const [rowKey, rowVersions] of rows) {
        // Convert column map to array (row representation)
        const row: Row = Array.from(rowVersions.values()).map(cv => cv.value);
        rowsArray.push(row);

        // Add column versions with their values
        for (const [column, cv] of rowVersions) {
          const versionKey = `${rowKey}:${column}`;
          columnVersions.set(versionKey, { hlc: cv.hlc, value: cv.value });
        }
      }

      tables.push({
        schema,
        table,
        rows: rowsArray,
        columnVersions,
      });
    }

    // Collect all schema migrations
    const schemaMigrations: SchemaMigration[] = [];
    const smBounds = buildAllSchemaMigrationsScanBounds();
    for await (const entry of this.kv.iterate(smBounds)) {
      const parsed = parseSchemaMigrationKey(entry.key);
      if (!parsed) continue;

      const migration = deserializeMigration(entry.value);
      schemaMigrations.push({
        type: migration.type,
        schema: parsed.schema,
        table: parsed.table,
        ddl: migration.ddl,
        hlc: migration.hlc,
        schemaVersion: migration.schemaVersion,
      });
    }

    return {
      siteId: this.getSiteId(),
      hlc: this.getCurrentHLC(),
      tables,
      schemaMigrations,
    };
  }

  async applySnapshot(snapshot: Snapshot): Promise<void> {
    // Clear existing sync metadata (column versions, tombstones, and change log)
    const batch = this.kv.batch();

    // Delete all existing column versions
    const cvBounds = buildAllColumnVersionsScanBounds();
    for await (const entry of this.kv.iterate(cvBounds)) {
      batch.delete(entry.key);
    }

    // Delete all existing tombstones
    const tbBounds = buildAllTombstonesScanBounds();
    for await (const entry of this.kv.iterate(tbBounds)) {
      batch.delete(entry.key);
    }

    // Delete all existing change log entries
    const clBounds = buildAllChangeLogScanBounds();
    for await (const entry of this.kv.iterate(clBounds)) {
      batch.delete(entry.key);
    }

    await batch.write();

    // Apply the snapshot's column versions and rebuild change log
    const applyBatch = this.kv.batch();

    for (const tableSnapshot of snapshot.tables) {
      for (const [versionKey, cvEntry] of tableSnapshot.columnVersions) {
        // versionKey format: {rowKey}:{column}
        const lastColon = versionKey.lastIndexOf(':');
        if (lastColon === -1) continue;

        const rowKey = versionKey.slice(0, lastColon);
        const column = versionKey.slice(lastColon + 1);
        const pk = JSON.parse(rowKey) as SqlValue[];

        this.columnVersions.setColumnVersionBatch(
          applyBatch,
          tableSnapshot.schema,
          tableSnapshot.table,
          pk,
          column,
          { hlc: cvEntry.hlc, value: cvEntry.value }
        );

        // Rebuild change log entry
        this.changeLog.recordColumnChangeBatch(
          applyBatch,
          cvEntry.hlc,
          tableSnapshot.schema,
          tableSnapshot.table,
          pk,
          column
        );
      }
    }

    await applyBatch.write();

    // Update our HLC to be at least as high as the snapshot
    this.hlcManager.receive(snapshot.hlc);
    await this.persistHLCState();

    // Emit sync state change
    this.syncEvents.emitSyncStateChange({ status: 'synced', lastSyncHLC: snapshot.hlc });
  }

  async updatePeerSyncState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
    await this.peerStates.setPeerState(peerSiteId, hlc);
  }

  async getPeerSyncState(peerSiteId: SiteId): Promise<HLC | undefined> {
    const state = await this.peerStates.getPeerState(peerSiteId);
    return state?.lastSyncHLC;
  }

  async pruneTombstones(): Promise<number> {
    const now = Date.now();
    let count = 0;
    const batch = this.kv.batch();

    const tbBounds = buildAllTombstonesScanBounds();
    for await (const entry of this.kv.iterate(tbBounds)) {
      const tombstone = deserializeTombstone(entry.value);

      if (now - tombstone.createdAt > this.config.tombstoneTTL) {
        batch.delete(entry.key);
        count++;
      }
    }

    await batch.write();
    return count;
  }

  /**
   * Get the sync event emitter for UI integration.
   */
  getEventEmitter(): SyncEventEmitterImpl {
    return this.syncEvents;
  }

  // ============================================================================
  // Streaming Snapshot API
  // ============================================================================

  async *getSnapshotStream(chunkSize: number = DEFAULT_SNAPSHOT_CHUNK_SIZE): AsyncIterable<SnapshotChunk> {
    const snapshotId = crypto.randomUUID();
    const siteId = this.getSiteId();
    const hlc = this.getCurrentHLC();

    // Count tables and migrations for header
    const tableKeys = new Set<string>();
    const cvBounds = buildAllColumnVersionsScanBounds();
    for await (const entry of this.kv.iterate(cvBounds)) {
      const parsed = parseColumnVersionKey(entry.key);
      if (parsed) tableKeys.add(`${parsed.schema}.${parsed.table}`);
    }

    let migrationCount = 0;
    const smBounds = buildAllSchemaMigrationsScanBounds();
    for await (const _entry of this.kv.iterate(smBounds)) {
      migrationCount++;
    }

    // Yield header
    const header: SnapshotHeaderChunk = {
      type: 'header',
      siteId,
      hlc,
      tableCount: tableKeys.size,
      migrationCount,
      snapshotId,
    };
    yield header;

    // Stream each table
    let totalEntries = 0;
    for (const tableKey of tableKeys) {
      const [schema, table] = tableKey.split('.');

      // Estimate entries for this table
      let tableEntryCount = 0;
      const tableCvBounds = buildAllColumnVersionsScanBounds();
      for await (const entry of this.kv.iterate(tableCvBounds)) {
        const parsed = parseColumnVersionKey(entry.key);
        if (parsed && parsed.schema === schema && parsed.table === table) {
          tableEntryCount++;
        }
      }

      // Yield table start
      const tableStart: SnapshotTableStartChunk = {
        type: 'table-start',
        schema,
        table,
        estimatedEntries: tableEntryCount,
      };
      yield tableStart;

      // Stream column versions in chunks
      let entries: Array<[string, HLC, SqlValue]> = [];
      let entriesWritten = 0;

      for await (const entry of this.kv.iterate(tableCvBounds)) {
        const parsed = parseColumnVersionKey(entry.key);
        if (!parsed || parsed.schema !== schema || parsed.table !== table) continue;

        const cv = deserializeColumnVersion(entry.value);
        const versionKey = `${encodePK(parsed.pk)}:${parsed.column}`;
        entries.push([versionKey, cv.hlc, cv.value]);
        entriesWritten++;

        if (entries.length >= chunkSize) {
          const chunk: SnapshotColumnVersionsChunk = {
            type: 'column-versions',
            schema,
            table,
            entries,
          };
          yield chunk;
          entries = [];
        }
      }

      // Yield remaining entries
      if (entries.length > 0) {
        const chunk: SnapshotColumnVersionsChunk = {
          type: 'column-versions',
          schema,
          table,
          entries,
        };
        yield chunk;
      }

      // Yield table end
      const tableEnd: SnapshotTableEndChunk = {
        type: 'table-end',
        schema,
        table,
        entriesWritten,
      };
      yield tableEnd;

      totalEntries += entriesWritten;
    }

    // Stream schema migrations
    for await (const entry of this.kv.iterate(smBounds)) {
      const parsed = parseSchemaMigrationKey(entry.key);
      if (!parsed) continue;

      const migration = deserializeMigration(entry.value);
      const migrationChunk: SnapshotSchemaMigrationChunk = {
        type: 'schema-migration',
        migration: {
          type: migration.type,
          schema: parsed.schema,
          table: parsed.table,
          ddl: migration.ddl,
          hlc: migration.hlc,
          schemaVersion: migration.schemaVersion,
        },
      };
      yield migrationChunk;
    }

    // Yield footer
    const footer: SnapshotFooterChunk = {
      type: 'footer',
      snapshotId,
      totalTables: tableKeys.size,
      totalEntries,
      totalMigrations: migrationCount,
    };
    yield footer;
  }

  async applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void> {
    let snapshotId: string | undefined;
    let snapshotHLC: HLC | undefined;
    let totalTables = 0;
    let totalEntries = 0;
    let tablesProcessed = 0;
    let entriesProcessed = 0;
    let currentTable: string | undefined;
    const completedTables: string[] = [];

    // Clear existing data before applying
    const clearBatch = this.kv.batch();
    for await (const entry of this.kv.iterate(buildAllColumnVersionsScanBounds())) {
      clearBatch.delete(entry.key);
    }
    for await (const entry of this.kv.iterate(buildAllTombstonesScanBounds())) {
      clearBatch.delete(entry.key);
    }
    for await (const entry of this.kv.iterate(buildAllChangeLogScanBounds())) {
      clearBatch.delete(entry.key);
    }
    await clearBatch.write();

    // Process chunks
    let batch = this.kv.batch();
    let batchSize = 0;
    const BATCH_FLUSH_SIZE = 1000;

    for await (const chunk of chunks) {
      switch (chunk.type) {
        case 'header':
          snapshotId = chunk.snapshotId;
          snapshotHLC = chunk.hlc;
          totalTables = chunk.tableCount;
          break;

        case 'table-start':
          currentTable = `${chunk.schema}.${chunk.table}`;
          totalEntries += chunk.estimatedEntries;
          break;

        case 'column-versions':
          for (const [versionKey, hlc, value] of chunk.entries) {
            const lastColon = versionKey.lastIndexOf(':');
            if (lastColon === -1) continue;

            const rowKey = versionKey.slice(0, lastColon);
            const column = versionKey.slice(lastColon + 1);
            const pk = JSON.parse(rowKey) as SqlValue[];

            this.columnVersions.setColumnVersionBatch(
              batch,
              chunk.schema,
              chunk.table,
              pk,
              column,
              { hlc, value }
            );

            this.changeLog.recordColumnChangeBatch(
              batch,
              hlc,
              chunk.schema,
              chunk.table,
              pk,
              column
            );

            batchSize++;
            entriesProcessed++;

            if (batchSize >= BATCH_FLUSH_SIZE) {
              await batch.write();
              batch = this.kv.batch();
              batchSize = 0;

              // Save checkpoint with completed tables
              if (snapshotId && snapshotHLC) {
                await this.saveSnapshotCheckpoint({
                  snapshotId,
                  siteId: this.getSiteId(),
                  hlc: snapshotHLC,
                  lastTableIndex: tablesProcessed,
                  lastEntryIndex: entriesProcessed,
                  completedTables: [...completedTables],
                  entriesProcessed,
                  createdAt: Date.now(),
                });
              }
            }
          }

          if (onProgress && snapshotId) {
            onProgress({
              snapshotId,
              tablesProcessed,
              totalTables,
              entriesProcessed,
              totalEntries,
              currentTable,
            });
          }
          break;

        case 'table-end':
          tablesProcessed++;
          if (currentTable) {
            completedTables.push(currentTable);
          }
          break;

        case 'schema-migration':
          // TODO: Apply schema migration
          break;

        case 'footer':
          // Flush remaining batch
          if (batchSize > 0) {
            await batch.write();
          }

          // Update HLC
          if (snapshotHLC) {
            this.hlcManager.receive(snapshotHLC);
            await this.persistHLCState();
          }

          // Clear checkpoint
          if (snapshotId) {
            await this.clearSnapshotCheckpoint(snapshotId);
          }

          // Emit sync state change
          if (snapshotHLC) {
            this.syncEvents.emitSyncStateChange({ status: 'synced', lastSyncHLC: snapshotHLC });
          }
          break;
      }
    }
  }

  async getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined> {
    const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${snapshotId}`);
    const data = await this.kv.get(key);
    if (!data) return undefined;

    const json = new TextDecoder().decode(data);
    const obj = JSON.parse(json);

    // Reconstruct HLC with proper types
    return {
      ...obj,
      hlc: {
        wallTime: BigInt(obj.hlc.wallTime),
        counter: obj.hlc.counter,
        siteId: new Uint8Array(obj.hlc.siteId),
      },
      siteId: new Uint8Array(obj.siteId),
    };
  }

  private async saveSnapshotCheckpoint(checkpoint: SnapshotCheckpoint): Promise<void> {
    const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${checkpoint.snapshotId}`);
    const json = JSON.stringify({
      ...checkpoint,
      hlc: {
        wallTime: checkpoint.hlc.wallTime.toString(),
        counter: checkpoint.hlc.counter,
        siteId: Array.from(checkpoint.hlc.siteId),
      },
      siteId: Array.from(checkpoint.siteId),
    });
    await this.kv.put(key, new TextEncoder().encode(json));
  }

  private async clearSnapshotCheckpoint(snapshotId: string): Promise<void> {
    const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${snapshotId}`);
    await this.kv.delete(key);
  }

  async *resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk> {
    // Resume streaming from checkpoint position
    // Skip tables that have already been completed
    const completedSet = new Set(checkpoint.completedTables);
    const snapshotId = checkpoint.snapshotId;
    const siteId = checkpoint.siteId;
    const hlc = checkpoint.hlc;

    // Count tables and migrations for header
    const tableKeys = new Set<string>();
    const cvBounds = buildAllColumnVersionsScanBounds();
    for await (const entry of this.kv.iterate(cvBounds)) {
      const parsed = parseColumnVersionKey(entry.key);
      if (parsed) tableKeys.add(`${parsed.schema}.${parsed.table}`);
    }

    let migrationCount = 0;
    const smBounds = buildAllSchemaMigrationsScanBounds();
    for await (const _entry of this.kv.iterate(smBounds)) {
      migrationCount++;
    }

    // Yield header (receiver needs to know this is a resume)
    const header: SnapshotHeaderChunk = {
      type: 'header',
      siteId,
      hlc,
      tableCount: tableKeys.size,
      migrationCount,
      snapshotId,
    };
    yield header;

    // Stream each table, skipping completed ones
    let totalEntries = checkpoint.entriesProcessed;
    for (const tableKey of tableKeys) {
      // Skip already completed tables
      if (completedSet.has(tableKey)) continue;

      const [schema, table] = tableKey.split('.');

      // Count entries for this table
      let tableEntryCount = 0;
      const tableCvBounds = buildAllColumnVersionsScanBounds();
      for await (const entry of this.kv.iterate(tableCvBounds)) {
        const parsed = parseColumnVersionKey(entry.key);
        if (parsed && parsed.schema === schema && parsed.table === table) {
          tableEntryCount++;
        }
      }

      // Yield table start
      const tableStart: SnapshotTableStartChunk = {
        type: 'table-start',
        schema,
        table,
        estimatedEntries: tableEntryCount,
      };
      yield tableStart;

      // Stream column versions in chunks
      let entries: Array<[string, HLC, SqlValue]> = [];
      let entriesWritten = 0;
      const chunkSize = DEFAULT_SNAPSHOT_CHUNK_SIZE;

      for await (const entry of this.kv.iterate(tableCvBounds)) {
        const parsed = parseColumnVersionKey(entry.key);
        if (!parsed || parsed.schema !== schema || parsed.table !== table) continue;

        const cv = deserializeColumnVersion(entry.value);
        const versionKey = `${encodePK(parsed.pk)}:${parsed.column}`;
        entries.push([versionKey, cv.hlc, cv.value]);
        entriesWritten++;

        if (entries.length >= chunkSize) {
          const chunk: SnapshotColumnVersionsChunk = {
            type: 'column-versions',
            schema,
            table,
            entries,
          };
          yield chunk;
          entries = [];
        }
      }

      // Yield remaining entries
      if (entries.length > 0) {
        const chunk: SnapshotColumnVersionsChunk = {
          type: 'column-versions',
          schema,
          table,
          entries,
        };
        yield chunk;
      }

      // Yield table end
      const tableEnd: SnapshotTableEndChunk = {
        type: 'table-end',
        schema,
        table,
        entriesWritten,
      };
      yield tableEnd;

      totalEntries += entriesWritten;
    }

    // Stream schema migrations
    for await (const entry of this.kv.iterate(smBounds)) {
      const parsed = parseSchemaMigrationKey(entry.key);
      if (!parsed) continue;

      const migration = deserializeMigration(entry.value);
      const migrationChunk: SnapshotSchemaMigrationChunk = {
        type: 'schema-migration',
        migration: {
          type: migration.type,
          schema: parsed.schema,
          table: parsed.table,
          ddl: migration.ddl,
          hlc: migration.hlc,
          schemaVersion: migration.schemaVersion,
        },
      };
      yield migrationChunk;
    }

    // Yield footer
    const footer: SnapshotFooterChunk = {
      type: 'footer',
      snapshotId,
      totalTables: tableKeys.size,
      totalEntries,
      totalMigrations: migrationCount,
    };
    yield footer;
  }
}
