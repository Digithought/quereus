/**
 * StoreManager - Multi-tenant LevelDB store management
 *
 * Manages lazy loading and cleanup of per-database LevelDB stores.
 * Each database gets its own isolated store, opened on-demand and
 * closed after idle timeout.
 *
 * This is a generic implementation. Applications provide custom database ID
 * parsing and path resolution via hooks in StoreManagerConfig.
 */

import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { StoreEventEmitter } from '@quereus/store';
import { LevelDBStore } from '@quereus/plugin-leveldb';
import {
  createSyncModule,
  type SyncManager,
} from '@quereus/sync';
import { serviceLog } from '../common/logger.js';

export interface StoreEntry {
  databaseId: string;
  store: LevelDBStore;
  syncManager: SyncManager;
  storeEvents: StoreEventEmitter;
  refCount: number;
  lastAccess: number;
}

/**
 * Context passed to store hooks for auth-aware decisions.
 */
export interface StoreContext {
  /** The raw auth token (e.g., JWT) */
  token?: string;
  /** User ID from authentication */
  userId?: string;
  /** Additional metadata from authentication */
  metadata?: Record<string, unknown>;
}

/**
 * Hooks for customizing store manager behavior.
 * Apps can provide these to implement custom database ID handling.
 */
export interface StoreManagerHooks {
  /**
   * Resolve a database ID to a storage path relative to dataDir.
   * @param databaseId The database identifier (any string)
   * @param context Optional auth context for auth-aware path resolution
   * @returns The storage path relative to dataDir
   * @default Returns sanitized databaseId (replaces unsafe chars)
   */
  resolveStoragePath?: (databaseId: string, context?: StoreContext) => string;

  /**
   * Validate a database ID.
   * @param databaseId The database identifier to validate
   * @param context Optional auth context for auth-aware validation
   * @returns True if valid, false otherwise
   * @default Returns true for non-empty strings
   */
  isValidDatabaseId?: (databaseId: string, context?: StoreContext) => boolean;
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
  /** Hooks for customizing behavior */
  hooks?: StoreManagerHooks;
}

/**
 * Sanitize a string for use as a filesystem path component.
 * Replaces unsafe characters with underscores.
 */
function sanitizePathComponent(value: string): string {
  // Allow alphanumeric, dash, underscore; replace others with underscore
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Default storage path resolver - simple sanitized passthrough.
 *
 * Applications can provide a custom resolveStoragePath hook for
 * org-based folder structures or other custom layouts.
 */
function defaultResolveStoragePath(databaseId: string, _context?: StoreContext): string {
  return sanitizePathComponent(databaseId);
}

/**
 * Default database ID validator - accepts any non-empty string with safe characters.
 *
 * Applications can provide a custom isValidDatabaseId hook for
 * stricter validation (e.g., org:type_id format).
 */
function defaultIsValidDatabaseId(databaseId: string, _context?: StoreContext): boolean {
  if (typeof databaseId !== 'string' || databaseId.length === 0) {
    return false;
  }
  // Accept alphanumeric with common separators
  return /^[a-zA-Z0-9_:.-]+$/.test(databaseId);
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
  private readonly resolveStoragePath: (databaseId: string, context?: StoreContext) => string;
  private readonly isValidDatabaseId: (databaseId: string, context?: StoreContext) => boolean;
  private readonly stores = new Map<string, StoreEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(config: Partial<StoreManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resolveStoragePath = config.hooks?.resolveStoragePath ?? defaultResolveStoragePath;
    this.isValidDatabaseId = config.hooks?.isValidDatabaseId ?? defaultIsValidDatabaseId;
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
   * @param databaseId The database identifier
   * @param context Optional auth context for auth-aware path resolution
   */
  async acquire(databaseId: string, context?: StoreContext): Promise<StoreEntry> {
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
    entry = await this.openStore(databaseId, context);
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
   * Check if a database ID is valid.
   * @param databaseId The database identifier
   * @param context Optional auth context for auth-aware validation
   */
  validateDatabaseId(databaseId: string, context?: StoreContext): boolean {
    return this.isValidDatabaseId(databaseId, context);
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

  private async openStore(databaseId: string, context?: StoreContext): Promise<StoreEntry> {
    // Validate database ID
    if (!this.isValidDatabaseId(databaseId, context)) {
      throw new Error(`Invalid database ID: ${databaseId}`);
    }

    const storagePath = this.resolveStoragePath(databaseId, context);
    const fullPath = join(this.config.dataDir, storagePath);

    // Ensure parent directories exist (org folder for new org-based format)
    const parentPath = join(this.config.dataDir, storagePath.split('/')[0]);
    await mkdir(parentPath, { recursive: true });

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

