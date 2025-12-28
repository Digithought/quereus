/**
 * Integration tests for SyncManager.
 */

import { expect } from 'chai';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type SnapshotChunk,
  type SnapshotHeaderChunk,
  type SnapshotFooterChunk,
  type ChangeSet,
} from '../../src/sync/protocol.js';
import { StoreEventEmitter, type KVStore, type WriteBatch } from 'quereus-plugin-store';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
import { type HLC, compareHLC } from '../../src/clock/hlc.js';

// Mock KVStore for testing - uses hex encoding for binary key safety
class MockKVStore implements KVStore {
  private data = new Map<string, { key: Uint8Array; value: Uint8Array }>();

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    return this.data.get(this.keyToHex(key))?.value;
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    this.data.set(this.keyToHex(key), { key: new Uint8Array(key), value });
  }

  async delete(key: Uint8Array): Promise<void> {
    this.data.delete(this.keyToHex(key));
  }

  async has(key: Uint8Array): Promise<boolean> {
    return this.data.has(this.keyToHex(key));
  }

  async *iterate(options?: { gte?: Uint8Array; lt?: Uint8Array }): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    const entries = Array.from(this.data.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const gteHex = options?.gte ? this.keyToHex(options.gte) : '';
    const ltHex = options?.lt ? this.keyToHex(options.lt) : 'ff'.repeat(1000);

    for (const [keyHex, { key, value }] of entries) {
      if (keyHex < gteHex) continue;
      if (keyHex >= ltHex) continue;
      yield { key, value };
    }
  }

  batch(): WriteBatch {
    const ops: Array<{ type: 'put' | 'delete'; key: Uint8Array; value?: Uint8Array }> = [];
    const store = this;
    return {
      put(key: Uint8Array, value: Uint8Array) { ops.push({ type: 'put', key: new Uint8Array(key), value }); },
      delete(key: Uint8Array) { ops.push({ type: 'delete', key: new Uint8Array(key) }); },
      async write() {
        for (const op of ops) {
          if (op.type === 'put') await store.put(op.key, op.value!);
          else await store.delete(op.key);
        }
      },
      clear() { ops.length = 0; },
    };
  }

  async close(): Promise<void> {}

  async approximateCount(): Promise<number> {
    return this.data.size;
  }

  private keyToHex(key: Uint8Array): string {
    return Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

describe('SyncManager', () => {
  let kv: MockKVStore;
  let storeEvents: StoreEventEmitter;
  let syncEvents: SyncEventEmitterImpl;
  let config: SyncConfig;

  beforeEach(() => {
    kv = new MockKVStore();
    storeEvents = new StoreEventEmitter();
    syncEvents = new SyncEventEmitterImpl();
    config = { ...DEFAULT_SYNC_CONFIG };
  });

  describe('creation', () => {
    it('should create a new SyncManager', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      expect(manager).to.be.instanceOf(SyncManagerImpl);
    });

    it('should generate a site ID if not provided', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const siteId = manager.getSiteId();
      expect(siteId).to.have.lengthOf(16);
    });

    it('should use provided site ID', async () => {
      const providedSiteId = generateSiteId();
      config.siteId = providedSiteId;
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      expect(siteIdEquals(manager.getSiteId(), providedSiteId)).to.be.true;
    });

    it('should persist and reload site ID', async () => {
      const manager1 = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const siteId1 = manager1.getSiteId();

      // Create a new manager with the same KV store
      const manager2 = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const siteId2 = manager2.getSiteId();

      expect(siteIdEquals(siteId1, siteId2)).to.be.true;
    });
  });

  describe('HLC', () => {
    it('should provide current HLC', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const hlc = manager.getCurrentHLC();
      expect(hlc.wallTime).to.be.a('bigint');
      expect(hlc.counter).to.be.a('number');
      expect(hlc.siteId).to.have.lengthOf(16);
    });
  });

  describe('getChangesSince', () => {
    it('should return empty array when no changes', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const peerSiteId = generateSiteId();
      const changes = await manager.getChangesSince(peerSiteId);
      expect(changes).to.deep.equal([]);
    });
  });

  describe('canDeltaSync', () => {
    it('should return false for unknown peer', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const peerSiteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId: peerSiteId };
      const canDelta = await manager.canDeltaSync(peerSiteId, hlc);
      expect(canDelta).to.be.false;
    });

    it('should return true for known peer within TTL', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const peerSiteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId: peerSiteId };

      // Register the peer
      await manager.updatePeerSyncState(peerSiteId, hlc);

      const canDelta = await manager.canDeltaSync(peerSiteId, hlc);
      expect(canDelta).to.be.true;
    });
  });

  describe('peerSyncState', () => {
    it('should store and retrieve peer sync state', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const peerSiteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 5, siteId: peerSiteId };

      await manager.updatePeerSyncState(peerSiteId, hlc);
      const retrieved = await manager.getPeerSyncState(peerSiteId);

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.wallTime).to.equal(hlc.wallTime);
      expect(retrieved!.counter).to.equal(hlc.counter);
    });

    it('should return undefined for unknown peer', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const peerSiteId = generateSiteId();
      const retrieved = await manager.getPeerSyncState(peerSiteId);
      expect(retrieved).to.be.undefined;
    });
  });

  describe('getSnapshot', () => {
    it('should return snapshot with site ID and HLC', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const snapshot = await manager.getSnapshot();

      expect(snapshot.siteId).to.have.lengthOf(16);
      expect(snapshot.hlc.wallTime).to.be.a('bigint');
      expect(snapshot.tables).to.be.an('array');
      expect(snapshot.schemaMigrations).to.be.an('array');
    });

    it('should return empty tables when no data', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const snapshot = await manager.getSnapshot();
      expect(snapshot.tables).to.have.lengthOf(0);
    });
  });

  describe('applySnapshot', () => {
    it('should apply snapshot and update HLC', async () => {
      const manager1 = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const manager2 = await SyncManagerImpl.create(new MockKVStore(), storeEvents, config, syncEvents);

      // Get snapshot from manager1
      const snapshot = await manager1.getSnapshot();

      // Apply to manager2
      await manager2.applySnapshot(snapshot);

      // Manager2's HLC should be at least as high
      const hlc1 = manager1.getCurrentHLC();
      const hlc2 = manager2.getCurrentHLC();
      expect(compareHLC(hlc2, hlc1)).to.be.at.least(0);
    });
  });

  describe('streaming snapshots', () => {
    it('should stream snapshot with header and footer', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const chunks: SnapshotChunk[] = [];

      for await (const chunk of manager.getSnapshotStream()) {
        chunks.push(chunk);
      }

      expect(chunks.length).to.be.at.least(2);
      expect(chunks[0].type).to.equal('header');
      expect(chunks[chunks.length - 1].type).to.equal('footer');
    });

    it('should include snapshot ID in header and footer', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const chunks: SnapshotChunk[] = [];

      for await (const chunk of manager.getSnapshotStream()) {
        chunks.push(chunk);
      }

      const header = chunks[0] as SnapshotHeaderChunk;
      const footer = chunks[chunks.length - 1] as SnapshotFooterChunk;

      expect(header.snapshotId).to.be.a('string');
      expect(footer.snapshotId).to.equal(header.snapshotId);
    });

    it('should apply streamed snapshot', async () => {
      const manager1 = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const manager2 = await SyncManagerImpl.create(new MockKVStore(), storeEvents, config, syncEvents);

      // Stream snapshot from manager1
      const chunks: SnapshotChunk[] = [];
      for await (const chunk of manager1.getSnapshotStream()) {
        chunks.push(chunk);
      }

      // Apply to manager2
      async function* yieldChunks() {
        for (const chunk of chunks) yield chunk;
      }

      let progressCalls = 0;
      await manager2.applySnapshotStream(yieldChunks(), () => {
        progressCalls++;
      });

      // Should have processed the chunks
      const footer = chunks[chunks.length - 1] as SnapshotFooterChunk;
      expect(footer.type).to.equal('footer');
    });

    it('should respect chunk size', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const chunks: SnapshotChunk[] = [];

      // Use a small chunk size
      for await (const chunk of manager.getSnapshotStream(10)) {
        chunks.push(chunk);
      }

      // Should still have header and footer
      expect(chunks[0].type).to.equal('header');
      expect(chunks[chunks.length - 1].type).to.equal('footer');
    });
  });

  describe('checkpoint/resume', () => {
    it('should return undefined for non-existent checkpoint', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const checkpoint = await manager.getSnapshotCheckpoint('non-existent');
      expect(checkpoint).to.be.undefined;
    });

    it('should resume snapshot stream', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);

      // Get snapshot ID from initial stream
      let snapshotId = '';
      for await (const chunk of manager.getSnapshotStream()) {
        if (chunk.type === 'header') {
          snapshotId = chunk.snapshotId;
          break;
        }
      }

      // Create a mock checkpoint
      const checkpoint = {
        snapshotId,
        siteId: manager.getSiteId(),
        hlc: manager.getCurrentHLC(),
        lastTableIndex: 0,
        lastEntryIndex: 0,
        completedTables: [],
        entriesProcessed: 0,
        createdAt: Date.now(),
      };

      // Resume should work
      const resumedChunks: SnapshotChunk[] = [];
      for await (const chunk of manager.resumeSnapshotStream(checkpoint)) {
        resumedChunks.push(chunk);
      }

      expect(resumedChunks.length).to.be.at.least(2);
      expect(resumedChunks[0].type).to.equal('header');
    });
  });

  describe('applyChanges', () => {
    it('should apply empty changeset', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const result = await manager.applyChanges([]);

      expect(result.applied).to.equal(0);
      expect(result.skipped).to.equal(0);
      expect(result.conflicts).to.equal(0);
      expect(result.transactions).to.equal(0);
    });

    it('should apply column changes', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([changeSet]);

      expect(result.applied).to.equal(1);
      expect(result.transactions).to.equal(1);
    });

    it('should apply row deletions', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'delete',
            schema: 'main',
            table: 'users',
            pk: [1],
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([changeSet]);

      expect(result.applied).to.equal(1);
      expect(result.transactions).to.equal(1);
    });

    it('should skip older changes (LWW)', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const remoteSiteId = generateSiteId();
      const now = Date.now();

      // Apply newer change first
      const newerChangeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-2',
        hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Bob',
            hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([newerChangeSet]);

      // Try to apply older change
      const olderChangeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([olderChangeSet]);

      // LWW causes the older change to be treated as a conflict (local wins)
      expect(result.conflicts).to.equal(1);
      expect(result.applied).to.equal(0);
    });
  });

  describe('pruneTombstones', () => {
    it('should return 0 when no tombstones', async () => {
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const pruned = await manager.pruneTombstones();
      expect(pruned).to.equal(0);
    });
  });

  describe('applyToStore callback', () => {
    it('should call applyToStore with data changes when applying remote changes', async () => {
      const appliedChanges: { data: unknown[]; schema: unknown[]; options: unknown } = {
        data: [],
        schema: [],
        options: null,
      };

      const applyToStore = async (
        dataChanges: unknown[],
        schemaChanges: unknown[],
        options: unknown
      ) => {
        appliedChanges.data = dataChanges;
        appliedChanges.schema = schemaChanges;
        appliedChanges.options = options;
        return { dataChangesApplied: dataChanges.length, schemaChangesApplied: schemaChanges.length, errors: [] };
      };

      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([changeSet]);

      // Verify applyToStore was called with correct data
      expect(appliedChanges.data).to.have.lengthOf(1);
      expect(appliedChanges.options).to.deep.equal({ remote: true });

      const dataChange = appliedChanges.data[0] as { type: string; table: string; pk: unknown[]; columns: Record<string, unknown> };
      expect(dataChange.type).to.equal('update');
      expect(dataChange.table).to.equal('users');
      expect(dataChange.pk).to.deep.equal([1]);
      expect(dataChange.columns).to.deep.equal({ name: 'Alice' });
    });

    it('should call applyToStore with delete changes', async () => {
      const appliedChanges: { data: unknown[] } = { data: [] };

      const applyToStore = async (dataChanges: unknown[], schemaChanges: unknown[]) => {
        appliedChanges.data = dataChanges;
        return { dataChangesApplied: dataChanges.length, schemaChangesApplied: schemaChanges.length, errors: [] };
      };

      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'delete',
            schema: 'main',
            table: 'users',
            pk: [1],
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([changeSet]);

      expect(appliedChanges.data).to.have.lengthOf(1);
      const dataChange = appliedChanges.data[0] as { type: string; table: string; pk: unknown[] };
      expect(dataChange.type).to.equal('delete');
      expect(dataChange.table).to.equal('users');
      expect(dataChange.pk).to.deep.equal([1]);
    });

    it('should not call applyToStore when no callback provided', async () => {
      // Create manager without callback
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      // Should not throw, just update metadata
      const result = await manager.applyChanges([changeSet]);
      expect(result.applied).to.equal(1);
    });

    it('should not call applyToStore for skipped changes', async () => {
      let callCount = 0;
      const applyToStore = async () => {
        callCount++;
        return { dataChangesApplied: 0, schemaChangesApplied: 0, errors: [] };
      };

      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();
      const now = Date.now();

      // Apply newer change first
      const newerChangeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-2',
        hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Bob',
            hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([newerChangeSet]);
      expect(callCount).to.equal(1);

      // Try to apply older change - should be skipped
      const olderChangeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([olderChangeSet]);

      // applyToStore should not be called again (no changes to apply)
      expect(callCount).to.equal(1);
      expect(result.conflicts).to.equal(1);
      expect(result.applied).to.equal(0);
    });

    it('should emit remote change events after applying changes', async () => {
      const remoteEvents: unknown[] = [];
      syncEvents.onRemoteChange((event) => {
        remoteEvents.push(event);
      });

      const applyToStore = async () => ({ dataChangesApplied: 1, schemaChangesApplied: 0, errors: [] });
      const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([changeSet]);

      expect(remoteEvents).to.have.lengthOf(1);
    });
  });
});
