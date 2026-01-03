/**
 * StoreManager - Multi-tenant LevelDB store management
 *
 * Manages lazy loading and cleanup of per-database LevelDB stores.
 * Each database gets its own isolated store, opened on-demand and
 * closed after idle timeout.
 */

import { join } from 'node:path';
import { LevelDBStore, StoreEventEmitter } from '@quereus/store';
import {
  createSyncModule,
  type SyncManager,
} from '@quereus/sync';
import { serviceLog } from '../common/logger.js';
import { getDatabaseStoragePath, parseDatabaseId } from './database-ids.js';

export interface StoreEntry {
  databaseId: string;
  store: LevelDBStore;
  syncManager: SyncManager;
  storeEvents: StoreEventEmitter;
  refCount: number;
  lastAccess: number;
}

export interface StoreManagerConfig {
  /** Base directory for all database stores */
  dataDir: string;
  /** Maximum number of stores to keep open (LRU eviction) */
  maxOpenStores: number;
  /** Idle timeout in ms before closing a store with refCount=0 */
  idleTimeoutMs: number;
  /** Interval for cleanup checks */
  cleanupIntervalMs: number;
  /** Sync config passed to createSyncModule */
  syncConfig?: {
    tombstoneTTL?: number;
    batchSize?: number;
  };
}

const DEFAULT_CONFIG: StoreManagerConfig = {
  dataDir: './data',
  maxOpenStores: 100,
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
  cleanupIntervalMs: 30 * 1000, // 30 seconds
};

/**
 * Manages multiple LevelDB stores for multi-tenant sync.
 */
export class StoreManager {
  private readonly config: StoreManagerConfig;
  private readonly stores = new Map<string, StoreEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(config: Partial<StoreManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the store manager (begins cleanup interval).
   */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
    serviceLog('StoreManager started with dataDir: %s', this.config.dataDir);
  }

  /**
   * Get or open a store for a database. Increments refCount.
   */
  async acquire(databaseId: string): Promise<StoreEntry> {
    // Check if already open
    let entry = this.stores.get(databaseId);
    if (entry) {
      entry.refCount++;
      entry.lastAccess = Date.now();
      serviceLog('Store acquired (cached): %s, refCount=%d', databaseId, entry.refCount);
      return entry;
    }

    // Check if we need to evict before opening new
    if (this.stores.size >= this.config.maxOpenStores) {
      await this.evictLRU();
    }

    // Open new store
    entry = await this.openStore(databaseId);
    this.stores.set(databaseId, entry);
    serviceLog('Store acquired (opened): %s', databaseId);
    return entry;
  }

  /**
   * Release a store reference. Decrements refCount.
   */
  release(databaseId: string): void {
    const entry = this.stores.get(databaseId);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastAccess = Date.now();
    serviceLog('Store released: %s, refCount=%d', databaseId, entry.refCount);
  }

  /**
   * Check if a store is currently open.
   */
  isOpen(databaseId: string): boolean {
    return this.stores.has(databaseId);
  }

  /**
   * Get an open store without acquiring (for read-only checks).
   */
  get(databaseId: string): StoreEntry | undefined {
    return this.stores.get(databaseId);
  }

  /**
   * Get count of open stores.
   */
  get openCount(): number {
    return this.stores.size;
  }

  /**
   * Shutdown all stores.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      const closePromises = Array.from(this.stores.entries()).map(async ([id, entry]) => {
        try {
          await entry.store.close();
          serviceLog('Store closed: %s', id);
        } catch (err) {
          serviceLog('Error closing store %s: %O', id, err);
        }
      });

      await Promise.all(closePromises);
      this.stores.clear();
      serviceLog('StoreManager shutdown complete');
    })();

    return this.shutdownPromise;
  }

  private async openStore(databaseId: string): Promise<StoreEntry> {
    // Validate database ID format
    parseDatabaseId(databaseId);

    const storagePath = getDatabaseStoragePath(databaseId);
    const fullPath = join(this.config.dataDir, storagePath);

    serviceLog('Opening store at: %s', fullPath);

    const store = await LevelDBStore.open({
      path: fullPath,
      createIfMissing: true,
    });

    const storeEvents = new StoreEventEmitter();
    const { syncManager } = await createSyncModule(store, storeEvents, this.config.syncConfig);

    return {
      databaseId,
      store,
      syncManager,
      storeEvents,
      refCount: 1,
      lastAccess: Date.now(),
    };
  }

  /**
   * Cleanup idle stores with refCount=0 past timeout.
   */
  private async cleanup(): Promise<void> {
    const now = Date.now();
    const toClose: string[] = [];

    for (const [id, entry] of this.stores) {
      if (entry.refCount === 0 && now - entry.lastAccess > this.config.idleTimeoutMs) {
        toClose.push(id);
      }
    }

    for (const id of toClose) {
      await this.closeStore(id);
    }

    if (toClose.length > 0) {
      serviceLog('Cleanup: closed %d idle stores', toClose.length);
    }
  }

  /**
   * Evict least recently used store (with refCount=0).
   */
  private async evictLRU(): Promise<void> {
    let oldest: { id: string; lastAccess: number } | null = null;

    for (const [id, entry] of this.stores) {
      // Only evict stores with no active references
      if (entry.refCount === 0) {
        if (!oldest || entry.lastAccess < oldest.lastAccess) {
          oldest = { id, lastAccess: entry.lastAccess };
        }
      }
    }

    if (oldest) {
      await this.closeStore(oldest.id);
      serviceLog('Evicted LRU store: %s', oldest.id);
    } else {
      serviceLog('Warning: Cannot evict, all stores have active references');
    }
  }

  /**
   * Close a specific store.
   */
  private async closeStore(databaseId: string): Promise<void> {
    const entry = this.stores.get(databaseId);
    if (!entry) return;

    try {
      await entry.store.close();
      this.stores.delete(databaseId);
      serviceLog('Store closed: %s', databaseId);
    } catch (err) {
      serviceLog('Error closing store %s: %O', databaseId, err);
    }
  }
}

