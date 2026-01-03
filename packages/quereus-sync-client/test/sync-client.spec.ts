import { expect } from 'chai';
import { SyncClient } from '../src/sync-client.js';
import type { SyncStatus, SyncEvent } from '../src/types.js';
import {
  generateSiteId,
  SyncEventEmitterImpl,
  type SyncManager,
  type HLC,
  type ChangeSet,
  type ApplyResult,
  type Snapshot,
  type SnapshotChunk,
  type SnapshotCheckpoint,
  type SnapshotProgress,
  type SiteId,
} from '@quereus/sync';

/**
 * Mock SyncManager for testing.
 */
class MockSyncManager implements SyncManager {
  private siteId = generateSiteId();

  getSiteId(): SiteId {
    return this.siteId;
  }

  getCurrentHLC(): HLC {
    return { wallTime: BigInt(Date.now()), counter: 0, siteId: this.siteId };
  }

  async getChangesSince(_peerSiteId: SiteId, _sinceHLC?: HLC): Promise<ChangeSet[]> {
    return [];
  }

  async applyChanges(_changes: ChangeSet[]): Promise<ApplyResult> {
    return { applied: 0, skipped: 0, conflicts: 0, transactions: 0 };
  }

  async canDeltaSync(_peerSiteId: SiteId, _sinceHLC: HLC): Promise<boolean> {
    return true;
  }

  async getSnapshot(): Promise<Snapshot> {
    return {
      siteId: this.siteId,
      hlc: this.getCurrentHLC(),
      tables: [],
      schemaMigrations: [],
    };
  }

  async applySnapshot(_snapshot: Snapshot): Promise<void> {}

  async updatePeerSyncState(_peerSiteId: SiteId, _hlc: HLC): Promise<void> {}

  async getPeerSyncState(_peerSiteId: SiteId): Promise<HLC | undefined> {
    return undefined;
  }

  async *getSnapshotStream(_chunkSize?: number): AsyncIterable<SnapshotChunk> {}

  async applySnapshotStream(
    _chunks: AsyncIterable<SnapshotChunk>,
    _onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void> {}

  async getSnapshotCheckpoint(_snapshotId: string): Promise<SnapshotCheckpoint | undefined> {
    return undefined;
  }

  async pruneTombstones(): Promise<number> {
    return 0;
  }

  async *resumeSnapshotStream(_checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk> {}
}

describe('SyncClient', () => {
  describe('constructor', () => {
    it('should create a SyncClient with required options', () => {
      const syncManager = new MockSyncManager();
      const syncEvents = new SyncEventEmitterImpl();

      const client = new SyncClient({
        syncManager,
        syncEvents,
      });

      expect(client).to.be.instanceOf(SyncClient);
      expect(client.status).to.deep.equal({ status: 'disconnected' });
      expect(client.isConnected).to.be.false;
      expect(client.isSynced).to.be.false;
    });

    it('should accept optional configuration', () => {
      const syncManager = new MockSyncManager();
      const syncEvents = new SyncEventEmitterImpl();
      const statusChanges: SyncStatus[] = [];
      const syncEventsReceived: SyncEvent[] = [];

      const client = new SyncClient({
        syncManager,
        syncEvents,
        autoReconnect: false,
        reconnectDelayMs: 2000,
        maxReconnectDelayMs: 30000,
        localChangeDebounceMs: 100,
        onStatusChange: (s) => statusChanges.push(s),
        onSyncEvent: (e) => syncEventsReceived.push(e),
      });

      expect(client).to.be.instanceOf(SyncClient);
    });
  });

  describe('disconnect', () => {
    it('should disconnect cleanly when not connected', async () => {
      const syncManager = new MockSyncManager();
      const syncEvents = new SyncEventEmitterImpl();
      const client = new SyncClient({ syncManager, syncEvents });

      // Should not throw
      await client.disconnect();

      expect(client.status).to.deep.equal({ status: 'disconnected' });
    });
  });

  describe('status tracking', () => {
    it('should report disconnected initially', () => {
      const syncManager = new MockSyncManager();
      const syncEvents = new SyncEventEmitterImpl();
      const client = new SyncClient({ syncManager, syncEvents });

      expect(client.status.status).to.equal('disconnected');
    });

    it('should call onStatusChange callback', async () => {
      const syncManager = new MockSyncManager();
      const syncEvents = new SyncEventEmitterImpl();
      const statusChanges: SyncStatus[] = [];

      const client = new SyncClient({
        syncManager,
        syncEvents,
        onStatusChange: (s) => statusChanges.push(s),
      });

      await client.disconnect();

      // disconnect should emit a disconnected status
      expect(statusChanges.some(s => s.status === 'disconnected')).to.be.true;
    });
  });
});

