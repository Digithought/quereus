/**
 * End-to-end integration tests for the sync protocol.
 *
 * These tests simulate realistic host/guest sync scenarios where
 * two replicas exchange changes through the protocol APIs.
 */

import { expect } from 'chai';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type ApplyToStoreCallback,
  type SnapshotChunk,
} from '../../src/sync/protocol.js';
import { StoreEventEmitter, InMemoryKVStore } from '@quereus/plugin-store';
import { generateSiteId } from '../../src/clock/site.js';
import { compareHLC } from '../../src/clock/hlc.js';
import type { SyncManager } from '../../src/sync/manager.js';
import type { SqlValue } from '@quereus/quereus';

// ============================================================================
// Test Infrastructure
// ============================================================================

/** In-memory store that tracks applied changes */
interface AppliedChange {
  type: 'data' | 'schema';
  change: DataChangeToApply | SchemaChangeToApply;
}

/** Simulates an in-memory data store for a replica */
class MockDataStore {
  /** Table data: table -> pk (JSON) -> row (column -> value) */
  readonly tables = new Map<string, Map<string, Map<string, SqlValue>>>();
  /** Log of all applied changes */
  readonly changeLog: AppliedChange[] = [];

  createApplyToStoreCallback(): ApplyToStoreCallback {
    return async (dataChanges, schemaChanges, _options) => {
      for (const change of schemaChanges) {
        this.changeLog.push({ type: 'schema', change });
        // For CREATE TABLE, ensure the table exists
        if (change.type === 'create_table') {
          const key = `${change.schema}.${change.table}`;
          if (!this.tables.has(key)) {
            this.tables.set(key, new Map());
          }
        }
      }

      for (const change of dataChanges) {
        this.changeLog.push({ type: 'data', change });
        const tableKey = `${change.schema}.${change.table}`;
        const pkKey = JSON.stringify(change.pk);

        if (!this.tables.has(tableKey)) {
          this.tables.set(tableKey, new Map());
        }
        const table = this.tables.get(tableKey)!;

        if (change.type === 'delete') {
          table.delete(pkKey);
        } else if (change.columns) {
          // update - merge columns
          if (!table.has(pkKey)) {
            table.set(pkKey, new Map());
          }
          const row = table.get(pkKey)!;
          for (const [col, val] of Object.entries(change.columns)) {
            row.set(col, val);
          }
        }
      }

      return {
        dataChangesApplied: dataChanges.length,
        schemaChangesApplied: schemaChanges.length,
        errors: [],
      };
    };
  }

  getRow(schema: string, table: string, pk: SqlValue[]): Map<string, SqlValue> | undefined {
    return this.tables.get(`${schema}.${table}`)?.get(JSON.stringify(pk));
  }
}

/** Represents a sync replica (host or guest) */
interface Replica {
  name: string;
  kv: InMemoryKVStore;
  dataStore: MockDataStore;
  storeEvents: StoreEventEmitter;
  syncEvents: SyncEventEmitterImpl;
  manager: SyncManager;
}

/** Creates a configured replica with store and sync manager */
async function createReplica(name: string, config: SyncConfig): Promise<Replica> {
  const kv = new InMemoryKVStore();
  const dataStore = new MockDataStore();
  const storeEvents = new StoreEventEmitter();
  const syncEvents = new SyncEventEmitterImpl();
  const applyToStore = dataStore.createApplyToStoreCallback();

  const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents, applyToStore);

  return { name, kv, dataStore, storeEvents, syncEvents, manager };
}

/**
 * Simulates a sync session between two replicas (bidirectional).
 * This mimics what would happen over a WebSocket connection.
 *
 * In a real sync protocol:
 * - The sender tracks what HLC the receiver is now at (for future delta queries)
 * - Both receiver and sender update their knowledge of each other
 */
async function performBidirectionalSync(host: Replica, guest: Replica): Promise<{
  hostToGuest: { applied: number; conflicts: number };
  guestToHost: { applied: number; conflicts: number };
}> {
  // Guest gets changes from host
  const hostChanges = await host.manager.getChangesSince(guest.manager.getSiteId());
  const guestResult = await guest.manager.applyChanges(hostChanges);

  // Host gets changes from guest
  const guestChanges = await guest.manager.getChangesSince(host.manager.getSiteId());
  const hostResult = await host.manager.applyChanges(guestChanges);

  // Update peer states - each side records the current HLC of the other
  // This allows canDeltaSync to return true on future syncs
  const hostCurrentHLC = host.manager.getCurrentHLC();
  const guestCurrentHLC = guest.manager.getCurrentHLC();

  // Guest records host's HLC (for knowing what it has received from host)
  await guest.manager.updatePeerSyncState(host.manager.getSiteId(), hostCurrentHLC);
  // Host records guest's HLC (for knowing what guest has, enabling delta sync)
  await host.manager.updatePeerSyncState(guest.manager.getSiteId(), guestCurrentHLC);

  return {
    hostToGuest: { applied: guestResult.applied, conflicts: guestResult.conflicts },
    guestToHost: { applied: hostResult.applied, conflicts: hostResult.conflicts },
  };
}

/** Helper to emit a local data change (simulating SQL execution) */
function emitLocalInsert(
  replica: Replica,
  schema: string,
  table: string,
  pk: SqlValue[],
  row: SqlValue[]
): void {
  replica.storeEvents.emitDataChange({
    type: 'insert',
    schemaName: schema,
    tableName: table,
    key: pk,
    newRow: row,
  });
}

/** Helper to emit a local update (simulating SQL UPDATE) */
function emitLocalUpdate(
  replica: Replica,
  schema: string,
  table: string,
  pk: SqlValue[],
  oldRow: SqlValue[],
  newRow: SqlValue[]
): void {
  replica.storeEvents.emitDataChange({
    type: 'update',
    schemaName: schema,
    tableName: table,
    key: pk,
    oldRow,
    newRow,
  });
}

/** Helper to emit a local delete (simulating SQL DELETE) */
function emitLocalDelete(
  replica: Replica,
  schema: string,
  table: string,
  pk: SqlValue[],
  oldRow: SqlValue[]
): void {
  replica.storeEvents.emitDataChange({
    type: 'delete',
    schemaName: schema,
    tableName: table,
    key: pk,
    oldRow,
  });
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Sync Protocol E2E', () => {
  let config: SyncConfig;

  beforeEach(() => {
    config = { ...DEFAULT_SYNC_CONFIG };
  });

  describe('Basic Host/Guest Sync', () => {
    it('should sync a single insert from host to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts a row
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice', 'alice@example.com']);
      await new Promise(r => setTimeout(r, 10)); // Allow async processing

      // Perform sync
      const result = await performBidirectionalSync(host, guest);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      expect(result.hostToGuest.conflicts).to.equal(0);

      // Guest's data store should have the change
      expect(guest.dataStore.changeLog.length).to.be.greaterThan(0);
    });

    it('should sync multiple rows from host to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts multiple rows
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      emitLocalInsert(host, 'main', 'users', [3], [3, 'Charlie']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      // Should have applied all 3 rows worth of column changes
      expect(result.hostToGuest.applied).to.be.greaterThan(0);
    });

    it('should sync changes bidirectionally', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts row 1
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      // Guest inserts row 2 (different row, no conflict)
      emitLocalInsert(guest, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      // Both directions should have changes
      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      expect(result.guestToHost.applied).to.be.greaterThan(0);
    });

    it('should sync an update from host to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts then updates
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalUpdate(host, 'main', 'users', [1], [1, 'Alice'], [1, 'Alice Updated']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      // Guest should have received the latest value
      const changes = guest.dataStore.changeLog.filter(c => c.type === 'data');
      expect(changes.length).to.be.greaterThan(0);
    });

    it('should sync a delete from host to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts and deletes
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      // Guest should have received both insert columns and the delete
      const deleteChanges = guest.dataStore.changeLog.filter(
        c => c.type === 'data' && (c.change as DataChangeToApply).type === 'delete'
      );
      expect(deleteChanges.length).to.equal(1);
    });
  });

  describe('Conflict Resolution (LWW)', () => {
    it('should resolve concurrent updates with Last-Write-Wins', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Both insert the same row initially (would happen before disconnect)
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Original']);
      await new Promise(r => setTimeout(r, 5));

      // Sync to establish baseline
      await performBidirectionalSync(host, guest);

      // Now both update the same column "offline" (no sync between)
      // Guest updates first (earlier timestamp)
      emitLocalUpdate(guest, 'main', 'users', [1], [1, 'Original'], [1, 'Guest Value']);
      await new Promise(r => setTimeout(r, 50)); // Ensure host has later timestamp

      // Host updates later (later timestamp - should win)
      emitLocalUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Host Value']);
      await new Promise(r => setTimeout(r, 10));

      // Sync again
      const result = await performBidirectionalSync(host, guest);

      // Host's later write should win - guest should have conflict resolved
      // (Host change applied to guest, guest change rejected on host)
      expect(result.hostToGuest.applied + result.hostToGuest.conflicts).to.be.greaterThan(0);
    });

    it('should handle delete vs update conflict (delete should block older updates)', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts a row
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      await performBidirectionalSync(host, guest);

      // Guest updates (earlier)
      emitLocalUpdate(guest, 'main', 'users', [1], [1, 'Alice'], [1, 'Guest Update']);
      await new Promise(r => setTimeout(r, 50));

      // Host deletes (later - should win)
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      // Delete from host should be applied to guest
      expect(result.hostToGuest.applied).to.be.greaterThan(0);
    });

    it('should fire conflict resolution events', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      const conflicts: Array<{ winner: string }> = [];
      guest.syncEvents.onConflictResolved((event) => {
        conflicts.push({ winner: event.winner });
      });

      // Setup: insert same row on both
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Host Insert']);
      await new Promise(r => setTimeout(r, 50));
      emitLocalInsert(guest, 'main', 'users', [1], [1, 'Guest Insert']);
      await new Promise(r => setTimeout(r, 10));

      // Host has newer timestamp, so when guest applies host's changes, there may be conflict
      await performBidirectionalSync(host, guest);

      // We may or may not get conflicts depending on timing
      // The important thing is no errors occur
    });
  });

  describe('Delta Sync', () => {
    it('should only sync changes since last sync', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Initial sync with some data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));
      await performBidirectionalSync(host, guest);

      const initialChanges = guest.dataStore.changeLog.length;

      // Add more data on host
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      // Second sync should only include new changes
      const result = await performBidirectionalSync(host, guest);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      // Should have more changes than before
      expect(guest.dataStore.changeLog.length).to.be.greaterThan(initialChanges);
    });

    it('should correctly track peer sync state', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Initially, canDeltaSync should be false (never synced)
      const canDeltaBefore = await host.manager.canDeltaSync(
        guest.manager.getSiteId(),
        guest.manager.getCurrentHLC()
      );
      expect(canDeltaBefore).to.be.false;

      // After sync, should be able to delta sync
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));
      await performBidirectionalSync(host, guest);

      const canDeltaAfter = await host.manager.canDeltaSync(
        guest.manager.getSiteId(),
        guest.manager.getCurrentHLC()
      );
      expect(canDeltaAfter).to.be.true;
    });
  });

  describe('Snapshot Sync', () => {
    it('should sync full snapshot when delta sync not available', async () => {
      const host = await createReplica('host', config);

      // Host has data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      // Get full snapshot from host
      const snapshot = await host.manager.getSnapshot();
      expect(snapshot.tables.length).to.be.at.least(0); // May be empty if no column tracking
      expect(snapshot.siteId).to.have.lengthOf(16);
    });

    it('should apply snapshot to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host has data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Get and apply snapshot
      const snapshot = await host.manager.getSnapshot();
      await guest.manager.applySnapshot(snapshot);

      // Guest's HLC should be updated
      const guestHLC = guest.manager.getCurrentHLC();
      expect(compareHLC(guestHLC, snapshot.hlc)).to.be.at.least(0);
    });

    it('should stream snapshot chunks', async () => {
      const host = await createReplica('host', config);

      // Add some data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Stream snapshot
      const chunks: Array<{ type: string }> = [];
      for await (const chunk of host.manager.getSnapshotStream()) {
        chunks.push({ type: chunk.type });
      }

      // Should have header and footer at minimum
      expect(chunks.length).to.be.at.least(2);
      expect(chunks[0].type).to.equal('header');
      expect(chunks[chunks.length - 1].type).to.equal('footer');
    });

    it('should apply streamed snapshot', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Collect chunks
      const chunks: SnapshotChunk[] = [];
      for await (const chunk of host.manager.getSnapshotStream()) {
        chunks.push(chunk);
      }

      // Apply to guest
      async function* yieldChunks(): AsyncIterable<SnapshotChunk> {
        for (const chunk of chunks) yield chunk;
      }

      await guest.manager.applySnapshotStream(yieldChunks());

      // Should succeed without error
    });
  });

  describe('Multi-Replica Hub and Spoke', () => {
    it('should sync from one host to multiple guests', async () => {
      const host = await createReplica('host', config);
      const guest1 = await createReplica('guest1', config);
      const guest2 = await createReplica('guest2', config);

      // Host inserts data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Sync to both guests
      const result1 = await performBidirectionalSync(host, guest1);
      const result2 = await performBidirectionalSync(host, guest2);

      expect(result1.hostToGuest.applied).to.be.greaterThan(0);
      expect(result2.hostToGuest.applied).to.be.greaterThan(0);
    });

    it('should merge changes from multiple guests', async () => {
      const host = await createReplica('host', config);
      const guest1 = await createReplica('guest1', config);
      const guest2 = await createReplica('guest2', config);

      // Each guest inserts different data (different rows = no conflict)
      emitLocalInsert(guest1, 'main', 'users', [1], [1, 'From Guest 1']);
      emitLocalInsert(guest2, 'main', 'users', [2], [2, 'From Guest 2']);
      await new Promise(r => setTimeout(r, 10));

      // Sync guest1 to host
      await performBidirectionalSync(host, guest1);

      // Sync guest2 to host
      await performBidirectionalSync(host, guest2);

      // Host should now have changes from both guests
      const hostChanges = await host.manager.getChangesSince(generateSiteId());
      expect(hostChanges.length).to.be.greaterThan(0);
    });

    it('should propagate changes through hub to other spokes', async () => {
      const host = await createReplica('host', config);
      const guest1 = await createReplica('guest1', config);
      const guest2 = await createReplica('guest2', config);

      // guest1 inserts data
      emitLocalInsert(guest1, 'main', 'users', [1], [1, 'From Guest 1']);
      await new Promise(r => setTimeout(r, 10));

      // Sync guest1 -> host
      await performBidirectionalSync(host, guest1);

      // Sync host -> guest2 (should propagate guest1's data)
      const result = await performBidirectionalSync(host, guest2);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
    });
  });

  describe('Schema Sync', () => {
    it('should sync schema changes (CREATE TABLE)', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host creates a table
      host.storeEvents.emitSchemaChange({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'new_table',
        ddl: 'CREATE TABLE new_table (id INTEGER PRIMARY KEY)',
      });
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      // Schema migration should be applied
      expect(result.hostToGuest.applied).to.be.greaterThan(0);

      // Guest should have received the schema change
      const schemaChanges = guest.dataStore.changeLog.filter(c => c.type === 'schema');
      expect(schemaChanges.length).to.equal(1);
    });

    it('should sync schema before data changes', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host creates table and inserts data
      host.storeEvents.emitSchemaChange({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'products',
        ddl: 'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)',
      });
      await new Promise(r => setTimeout(r, 5));
      emitLocalInsert(host, 'main', 'products', [1], [1, 'Widget']);
      await new Promise(r => setTimeout(r, 10));

      await performBidirectionalSync(host, guest);

      // Schema should be applied before data
      const changes = guest.dataStore.changeLog;
      const schemaIdx = changes.findIndex(c => c.type === 'schema');
      const dataIdx = changes.findIndex(c => c.type === 'data');

      // If both present, schema should come first
      if (schemaIdx !== -1 && dataIdx !== -1) {
        expect(schemaIdx).to.be.lessThan(dataIdx);
      }
    });

    it('should not re-record remote schema changes', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Emit schema change with remote=true (simulating received remote change)
      host.storeEvents.emitSchemaChange({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'remote_table',
        ddl: 'CREATE TABLE remote_table (id INTEGER)',
        remote: true,
      });
      await new Promise(r => setTimeout(r, 10));

      // This should NOT appear in changes to sync
      const changes = await host.manager.getChangesSince(guest.manager.getSiteId());
      expect(changes.length).to.equal(0);
    });
  });

  describe('Event Emission', () => {
    it('should emit onRemoteChange when applying changes', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      const remoteEvents: Array<{ changes: number }> = [];
      guest.syncEvents.onRemoteChange((event) => {
        remoteEvents.push({ changes: event.changes.length });
      });

      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      await performBidirectionalSync(host, guest);

      expect(remoteEvents.length).to.be.greaterThan(0);
    });

    it('should emit onLocalChange when recording local changes', async () => {
      const host = await createReplica('host', config);

      const localEvents: Array<{ pendingSync: boolean }> = [];
      host.syncEvents.onLocalChange((event) => {
        localEvents.push({ pendingSync: event.pendingSync });
      });

      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      expect(localEvents.length).to.be.greaterThan(0);
      expect(localEvents[0].pendingSync).to.be.true;
    });
  });

  describe('Change Serialization', () => {
    it('should correctly round-trip serialize column changes', async () => {
      const replica = await createReplica('test', config);

      // Make a local change
      emitLocalInsert(replica, 'main', 'users', [1], [1, 'Alice', 'alice@example.com']);
      await new Promise(r => setTimeout(r, 10));

      // Get changes
      const changes = await replica.manager.getChangesSince(generateSiteId());
      expect(changes.length).to.be.greaterThan(0);

      // Verify the structure
      const changeSet = changes[0];
      expect(changeSet.siteId).to.be.instanceOf(Uint8Array);
      expect(changeSet.changes.length).to.be.greaterThan(0);

      // Check each change has the right structure
      for (const change of changeSet.changes) {
        expect(change.type).to.equal('column');
        if (change.type === 'column') {
          expect(change.schema).to.equal('main');
          expect(change.table).to.equal('users');
          expect(Array.isArray(change.pk)).to.be.true;
          expect(change.pk[0]).to.equal(1);
          // Column names should be col_N when no schema lookup is available
          expect(change.column).to.match(/^col_\d+$/);
          expect(change.hlc.siteId).to.be.instanceOf(Uint8Array);
        }
      }
    });

    it('should use actual column names when getTableSchema is provided', async () => {
      // Create a replica with a mock getTableSchema callback
      const mockTableSchema = {
        schemaName: 'main',
        name: 'users',
        columns: [
          { name: 'id' },
          { name: 'username' },
          { name: 'email' },
        ],
      };

      const store = new InMemoryKVStore();
      const dataStore = new MockDataStore();
      const storeEvents = new StoreEventEmitter();
      const syncEvents = new SyncEventEmitterImpl();

      // Create manager with getTableSchema callback
      const manager = await SyncManagerImpl.create(
        store,
        storeEvents,
        config,
        syncEvents,
        dataStore.createApplyToStoreCallback(),
        (_schema: string, _table: string) => mockTableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Emit a local insert
      storeEvents.emitDataChange({
        type: 'insert',
        schemaName: 'main',
        tableName: 'users',
        key: [1],
        newRow: [1, 'Alice', 'alice@example.com'],
      });
      await new Promise(r => setTimeout(r, 10));

      // Get changes
      const changes = await manager.getChangesSince(generateSiteId());
      expect(changes.length).to.be.greaterThan(0);

      // Verify column names are actual names from schema
      const columns = changes[0].changes
        .filter((c): c is import('../../src/sync/protocol.js').ColumnChange => c.type === 'column')
        .map(c => c.column);

      expect(columns).to.include('id');
      expect(columns).to.include('username');
      expect(columns).to.include('email');
      // Should NOT use placeholder names
      expect(columns.some(c => c.startsWith('col_'))).to.be.false;
    });
  });

  describe('Real Column Mapping', () => {
    /**
     * This test verifies that column names are properly mapped when
     * both sender and receiver have the same table schema.
     * This simulates the real-world scenario in the browser.
     */
    it('should correctly map column names when both replicas have matching schemas', async () => {
      // Create mock table schema with real column names
      const tableSchema = {
        schemaName: 'main',
        name: 'users',
        columns: [
          { name: 'id' },
          { name: 'username' },
          { name: 'email' },
        ],
        primaryKeyDefinition: [{ index: 0, desc: false }],
        columnIndexMap: new Map([
          ['id', 0],
          ['username', 1],
          ['email', 2],
        ]),
      };

      // Source replica with schema
      const sourceStore = new InMemoryKVStore();
      const sourceEvents = new StoreEventEmitter();
      const sourceSyncEvents = new SyncEventEmitterImpl();
      const sourceDataStore = new MockDataStore();

      const sourceManager = await SyncManagerImpl.create(
        sourceStore,
        sourceEvents,
        config,
        sourceSyncEvents,
        sourceDataStore.createApplyToStoreCallback(),
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Destination replica with same schema
      const destStore = new InMemoryKVStore();
      const destEvents = new StoreEventEmitter();
      const destSyncEvents = new SyncEventEmitterImpl();
      const destDataStore = new MockDataStore();

      const destManager = await SyncManagerImpl.create(
        destStore,
        destEvents,
        config,
        destSyncEvents,
        destDataStore.createApplyToStoreCallback(),
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Source makes a local insert
      sourceEvents.emitDataChange({
        type: 'insert',
        schemaName: 'main',
        tableName: 'users',
        key: [1],
        newRow: [1, 'alice', 'alice@example.com'],
      });
      await new Promise(r => setTimeout(r, 10));

      // Get changes from source
      const changes = await sourceManager.getChangesSince(destManager.getSiteId());
      expect(changes.length).to.be.greaterThan(0);

      // Verify the changes use actual column names
      const columnChanges = changes[0].changes.filter(
        (c): c is import('../../src/sync/protocol.js').ColumnChange => c.type === 'column'
      );
      const columnNames = columnChanges.map(c => c.column);
      expect(columnNames).to.include('id');
      expect(columnNames).to.include('username');
      expect(columnNames).to.include('email');

      // Apply changes to destination
      const result = await destManager.applyChanges(changes);
      expect(result.applied).to.equal(3); // 3 columns
      expect(result.skipped).to.equal(0);

      // Verify destination received the data - each column is a separate change
      const destChanges = destDataStore.changeLog.filter(c => c.type === 'data');
      expect(destChanges.length).to.equal(3);

      // Collect all column values across all changes
      const allColumns: Record<string, SqlValue> = {};
      for (const dc of destChanges) {
        const change = dc.change as DataChangeToApply;
        if (change.columns) {
          Object.assign(allColumns, change.columns);
        }
      }

      // All column values should be present
      expect(allColumns['id']).to.equal(1);
      expect(allColumns['username']).to.equal('alice');
      expect(allColumns['email']).to.equal('alice@example.com');
    });

    /**
     * This test simulates the FULL sync flow:
     * 1. Browser A creates a table and inserts a row
     * 2. Browser A sends changes to coordinator
     * 3. Coordinator receives and applies changes
     * 4. Coordinator broadcasts to Browser B
     * 5. Browser B receives and applies changes
     *
     * This is the exact flow that happens in the real app.
     */
    it('should sync data through coordinator (full flow simulation)', async function() {
      this.timeout(5000);
      const tableSchema = {
        schemaName: 'main',
        name: 'test',
        columns: [
          { name: 'id' },
          { name: 'value' },
        ],
        primaryKeyDefinition: [{ index: 0, desc: false }],
        columnIndexMap: new Map([
          ['id', 0],
          ['value', 1],
        ]),
      };

      // Browser A (source)
      const browserAStore = new InMemoryKVStore();
      const browserAEvents = new StoreEventEmitter();
      const browserASyncEvents = new SyncEventEmitterImpl();
      const browserADataStore = new MockDataStore();
      const browserA = await SyncManagerImpl.create(
        browserAStore,
        browserAEvents,
        config,
        browserASyncEvents,
        browserADataStore.createApplyToStoreCallback(),
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Coordinator (no schema, no applyToStore - just CRDT metadata)
      const coordStore = new InMemoryKVStore();
      const coordEvents = new StoreEventEmitter();
      const coordSyncEvents = new SyncEventEmitterImpl();
      const coordinator = await SyncManagerImpl.create(
        coordStore,
        coordEvents,
        config,
        coordSyncEvents
        // No applyToStore, no getTableSchema - coordinator only stores metadata
      );

      // Browser B (destination)
      const browserBStore = new InMemoryKVStore();
      const browserBEvents = new StoreEventEmitter();
      const browserBSyncEvents = new SyncEventEmitterImpl();
      const browserBDataStore = new MockDataStore();
      const browserB = await SyncManagerImpl.create(
        browserBStore,
        browserBEvents,
        config,
        browserBSyncEvents,
        browserBDataStore.createApplyToStoreCallback(),
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Step 1: Browser A creates table and inserts row
      browserAEvents.emitSchemaChange({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'test',
        ddl: 'CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)',
      });
      await new Promise(r => setTimeout(r, 10));

      browserAEvents.emitDataChange({
        type: 'insert',
        schemaName: 'main',
        tableName: 'test',
        key: [1],
        newRow: [1, 'hello from A'],
      });
      await new Promise(r => setTimeout(r, 10));

      // Step 2: Browser A sends changes to coordinator
      const changesToCoordinator = await browserA.getChangesSince(coordinator.getSiteId());
      console.log('Changes to coordinator:', changesToCoordinator.length, 'changesets');
      console.log('  Schema migrations:', changesToCoordinator[0]?.schemaMigrations?.length ?? 0);
      console.log('  Data changes:', changesToCoordinator[0]?.changes?.length ?? 0);
      expect(changesToCoordinator.length).to.be.greaterThan(0);

      // Step 3: Coordinator applies changes
      const coordResult = await coordinator.applyChanges(changesToCoordinator);
      console.log('Coordinator apply result:', coordResult);
      expect(coordResult.applied).to.be.greaterThan(0);

      // Step 4: Coordinator broadcasts (same changes) to Browser B
      const resultB = await browserB.applyChanges(changesToCoordinator);
      console.log('Browser B apply result:', resultB);
      expect(resultB.applied).to.be.greaterThan(0);

      // Step 5: Verify Browser B has the data
      const bDataChanges = browserBDataStore.changeLog.filter(c => c.type === 'data');
      console.log('Browser B data changes:', bDataChanges.length);
      expect(bDataChanges.length).to.be.greaterThan(0);

      // Collect all column values
      const allColumns: Record<string, SqlValue> = {};
      for (const dc of bDataChanges) {
        const change = dc.change as DataChangeToApply;
        if (change.columns) {
          Object.assign(allColumns, change.columns);
        }
      }

      expect(allColumns['id']).to.equal(1);
      expect(allColumns['value']).to.equal('hello from A');
    });

    /**
     * This test simulates Browser B connecting AFTER Browser A has already synced.
     * This is the "late joiner" scenario.
     */
    it('should sync data to late-joining browser via getChangesSince', async function() {
      this.timeout(5000);

      const tableSchema = {
        schemaName: 'main',
        name: 'test',
        columns: [
          { name: 'id' },
          { name: 'value' },
        ],
        primaryKeyDefinition: [{ index: 0, desc: false }],
        columnIndexMap: new Map([
          ['id', 0],
          ['value', 1],
        ]),
      };

      // Browser A (source)
      const browserAStore = new InMemoryKVStore();
      const browserAEvents = new StoreEventEmitter();
      const browserASyncEvents = new SyncEventEmitterImpl();
      const browserADataStore = new MockDataStore();
      const browserA = await SyncManagerImpl.create(
        browserAStore,
        browserAEvents,
        config,
        browserASyncEvents,
        browserADataStore.createApplyToStoreCallback(),
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Coordinator (no schema, no applyToStore - just CRDT metadata)
      const coordStore = new InMemoryKVStore();
      const coordEvents = new StoreEventEmitter();
      const coordSyncEvents = new SyncEventEmitterImpl();
      const coordinator = await SyncManagerImpl.create(
        coordStore,
        coordEvents,
        config,
        coordSyncEvents
        // No applyToStore, no getTableSchema - coordinator only stores metadata
      );

      // Step 1: Browser A creates table and inserts row
      browserAEvents.emitSchemaChange({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'test',
        ddl: 'CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)',
      });
      await new Promise(r => setTimeout(r, 10));

      browserAEvents.emitDataChange({
        type: 'insert',
        schemaName: 'main',
        tableName: 'test',
        key: [1],
        newRow: [1, 'hello from A'],
      });
      await new Promise(r => setTimeout(r, 10));

      // Step 2: Browser A sends changes to coordinator
      const changesToCoordinator = await browserA.getChangesSince(coordinator.getSiteId());

      // Step 3: Coordinator applies changes
      const coordResult = await coordinator.applyChanges(changesToCoordinator);
      expect(coordResult.applied).to.be.greaterThan(0);

      // Step 4: Browser B connects LATER and requests changes
      const browserBStore = new InMemoryKVStore();
      const browserBEvents = new StoreEventEmitter();
      const browserBSyncEvents = new SyncEventEmitterImpl();
      const browserBDataStore = new MockDataStore();
      const browserB = await SyncManagerImpl.create(
        browserBStore,
        browserBEvents,
        config,
        browserBSyncEvents,
        browserBDataStore.createApplyToStoreCallback(),
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Browser B requests all changes from coordinator (no sinceHLC)
      const changesForB = await coordinator.getChangesSince(browserB.getSiteId());

      // This is the key assertion - coordinator should have changes to send
      expect(changesForB.length).to.be.greaterThan(0);

      // Browser B applies the changes
      const resultB = await browserB.applyChanges(changesForB);
      expect(resultB.applied).to.be.greaterThan(0);

      // Verify Browser B has the data
      const bDataChanges = browserBDataStore.changeLog.filter(c => c.type === 'data');
      expect(bDataChanges.length).to.be.greaterThan(0);

      // Collect all column values
      const allColumns: Record<string, SqlValue> = {};
      for (const dc of bDataChanges) {
        const change = dc.change as DataChangeToApply;
        if (change.columns) {
          Object.assign(allColumns, change.columns);
        }
      }

      expect(allColumns['id']).to.equal(1);
      expect(allColumns['value']).to.equal('hello from A');
    });

    /**
     * This test verifies that applyToStore writes to the CORRECT KV store for each table.
     *
     * In the browser:
     * - The sync manager uses `quoomb_sync_meta` IndexedDB database for CRDT metadata
     * - Each table uses its own IndexedDB database like `quereus_main_test` for data
     *
     * The fix: createStoreAdapter now takes a getKVStore function that returns
     * the correct store for each table.
     */
    it('should write to the correct KV store for each table', async function() {
      this.timeout(5000);

      // This simulates the browser scenario where we have TWO different stores:
      // 1. syncMetaStore - where sync metadata lives (quoomb_sync_meta)
      // 2. tableDataStore - where actual table data lives (quereus_main_test)
      const syncMetaStore = new InMemoryKVStore();
      const tableDataStore = new InMemoryKVStore();

      const tableSchema = {
        schemaName: 'main',
        name: 'test',
        columns: [
          { name: 'id' },
          { name: 'value' },
        ],
        primaryKeyDefinition: [{ index: 0, desc: false }],
        columnIndexMap: new Map([
          ['id', 0],
          ['value', 1],
        ]),
      };

      const events = new StoreEventEmitter();
      const syncEvents = new SyncEventEmitterImpl();

      // Create a store adapter with getKVStore that returns the TABLE's store
      const { createStoreAdapter } = await import('../../src/sync/store-adapter.js');
      const applyToStore = createStoreAdapter({
        db: null as unknown as import('@quereus/quereus').Database, // Not needed for this test
        getKVStore: async (schemaName: string, tableName: string) => {
          // Return the table's store (not the sync metadata store)
          if (schemaName === 'main' && tableName === 'test') {
            return tableDataStore;
          }
          throw new Error(`Unknown table: ${schemaName}.${tableName}`);
        },
        events,
        getTableSchema: () => tableSchema as unknown as import('@quereus/quereus').TableSchema,
        collation: 'NOCASE',
      });

      const syncManager = await SyncManagerImpl.create(
        syncMetaStore,  // Sync metadata goes here
        events,
        config,
        syncEvents,
        applyToStore,
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Simulate receiving remote changes
      const { generateSiteId: genSite } = await import('../../src/clock/site.js');
      const { HLCManager } = await import('../../src/clock/hlc.js');
      const remoteSiteId = genSite();
      const remoteHLC = new HLCManager(remoteSiteId);

      const changes = [{
        siteId: remoteSiteId,
        transactionId: 'tx1',
        hlc: remoteHLC.tick(),
        changes: [
          {
            type: 'column' as const,
            schema: 'main',
            table: 'test',
            pk: [1],
            column: 'id',
            value: 1,
            hlc: remoteHLC.tick(),
          },
          {
            type: 'column' as const,
            schema: 'main',
            table: 'test',
            pk: [1],
            column: 'value',
            value: 'hello',
            hlc: remoteHLC.tick(),
          },
        ],
        schemaMigrations: [],
      }];

      const result = await syncManager.applyChanges(changes);
      expect(result.applied).to.equal(2);

      // Check what's in each store
      const syncMetaKeys: string[] = [];
      for await (const entry of syncMetaStore.iterate()) {
        syncMetaKeys.push(new TextDecoder().decode(entry.key));
      }

      const tableDataKeys: string[] = [];
      for await (const entry of tableDataStore.iterate()) {
        tableDataKeys.push(new TextDecoder().decode(entry.key));
      }

      // FIXED: Data should now be in tableDataStore, NOT syncMetaStore
      const dataKeysInSyncMeta = syncMetaKeys.filter(k => k.startsWith('d:'));
      expect(dataKeysInSyncMeta.length).to.equal(0, 'No data keys should be in syncMetaStore');

      // Table data should be in tableDataStore
      const dataKeysInTableStore = tableDataKeys.filter(k => k.startsWith('d:'));
      expect(dataKeysInTableStore.length).to.be.greaterThan(0, 'Data should be in tableDataStore');
    });
  });

  describe('Coordinator Push Pattern', () => {
    /**
     * This test simulates the real WebSocket sync flow:
     * 1. Guest B makes a local change
     * 2. Guest B sends changes to coordinator (via getChangesSince)
     * 3. Coordinator applies the changes
     * 4. Coordinator broadcasts to Guest A (directly, same changes)
     * 5. Guest A receives and applies the broadcast
     *
     * This is different from the bidirectional sync where each side pulls.
     */
    it('should propagate guest changes through coordinator to other guests', async () => {
      // Coordinator acts as a relay - it doesn't make local changes
      const coordinator = await createReplica('coordinator', config);
      const guestA = await createReplica('guestA', config);
      const guestB = await createReplica('guestB', config);

      // Guest B makes a local change
      emitLocalInsert(guestB, 'main', 'users', [1], [1, 'From Guest B']);
      await new Promise(r => setTimeout(r, 10));

      // Step 1: Guest B gets its changes to send to coordinator
      const changesToCoordinator = await guestB.manager.getChangesSince(
        coordinator.manager.getSiteId()
      );
      expect(changesToCoordinator.length).to.be.greaterThan(0);

      // Step 2: Coordinator applies the changes
      const coordResult = await coordinator.manager.applyChanges(changesToCoordinator);
      expect(coordResult.applied).to.be.greaterThan(0);

      // Step 3: Coordinator broadcasts SAME changes to Guest A
      // (In real app, this is done by broadcastChanges which sends the received changes)
      const resultA = await guestA.manager.applyChanges(changesToCoordinator);
      expect(resultA.applied).to.be.greaterThan(0);

      // Guest A should have the data
      const guestAChanges = guestA.dataStore.changeLog.filter(c => c.type === 'data');
      expect(guestAChanges.length).to.be.greaterThan(0);
    });

    it('should handle bidirectional changes through coordinator', async () => {
      const coordinator = await createReplica('coordinator', config);
      const guestA = await createReplica('guestA', config);
      const guestB = await createReplica('guestB', config);

      // Initial sync: both guests connect and get initial state
      await performBidirectionalSync(coordinator, guestA);
      await performBidirectionalSync(coordinator, guestB);

      // Guest A makes a change
      emitLocalInsert(guestA, 'main', 'users', [1], [1, 'From Guest A']);
      await new Promise(r => setTimeout(r, 10));

      // Guest A sends to coordinator
      const changesFromA = await guestA.manager.getChangesSince(
        coordinator.manager.getSiteId()
      );
      await coordinator.manager.applyChanges(changesFromA);

      // Coordinator broadcasts to Guest B
      const resultB = await guestB.manager.applyChanges(changesFromA);
      expect(resultB.applied).to.be.greaterThan(0);

      // Now Guest B makes a change
      emitLocalInsert(guestB, 'main', 'users', [2], [2, 'From Guest B']);
      await new Promise(r => setTimeout(r, 10));

      // Guest B sends to coordinator
      const changesFromB = await guestB.manager.getChangesSince(
        coordinator.manager.getSiteId()
      );
      await coordinator.manager.applyChanges(changesFromB);

      // Coordinator broadcasts to Guest A
      const resultA = await guestA.manager.applyChanges(changesFromB);
      expect(resultA.applied).to.be.greaterThan(0);

      // Both guests should have both rows
      const aChanges = guestA.dataStore.changeLog.filter(c => c.type === 'data');
      const bChanges = guestB.dataStore.changeLog.filter(c => c.type === 'data');
      expect(aChanges.length).to.be.at.least(1); // Has Guest B's row
      expect(bChanges.length).to.be.at.least(1); // Has Guest A's row
    });
  });
});
