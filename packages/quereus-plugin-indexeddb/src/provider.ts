/**
 * IndexedDB KVStore provider implementation.
 *
 * Uses a unified single-database architecture where all tables share one
 * IndexedDB database with multiple object stores (one per table).
 * This enables cross-table atomic transactions using native IDB transaction support.
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import { IndexedDBStore } from './store.js';
import { IndexedDBManager } from './manager.js';

/**
 * Options for creating an IndexedDB provider.
 */
export interface IndexedDBProviderOptions {
  /**
   * Name for the unified IndexedDB database.
   * All tables share this single database with separate object stores.
   * @default 'quereus'
   */
  databaseName?: string;
}

/**
 * IndexedDB implementation of KVStoreProvider.
 *
 * Uses a unified single-database architecture where all tables share one
 * IndexedDB database with multiple object stores (one per table).
 */
export class IndexedDBProvider implements KVStoreProvider {
  private databaseName: string;
  private stores = new Map<string, IndexedDBStore>();
  private catalogStore: IndexedDBStore | null = null;
  private manager: IndexedDBManager;

  constructor(options: IndexedDBProviderOptions = {}) {
    this.databaseName = options.databaseName ?? 'quereus';
    this.manager = IndexedDBManager.getInstance(this.databaseName);
  }

  /**
   * Get the object store name for a table.
   */
  private getStoreKey(schemaName: string, tableName: string): string {
    return `${schemaName}.${tableName}`.toLowerCase();
  }

  async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
    const key = this.getStoreKey(schemaName, tableName);
    let store = this.stores.get(key);

    if (!store) {
      store = await IndexedDBStore.openForTable(this.databaseName, key);
      this.stores.set(key, store);
    }

    return store;
  }

  async getCatalogStore(): Promise<KVStore> {
    if (!this.catalogStore) {
      this.catalogStore = await IndexedDBStore.openForTable(
        this.databaseName,
        this.manager.getCatalogStoreName()
      );
    }
    return this.catalogStore;
  }

  async closeStore(schemaName: string, tableName: string): Promise<void> {
    const key = this.getStoreKey(schemaName, tableName);
    const store = this.stores.get(key);
    if (store) {
      await store.close();
      this.stores.delete(key);
    }
  }

  async closeAll(): Promise<void> {
    for (const store of this.stores.values()) {
      await store.close();
    }
    this.stores.clear();

    if (this.catalogStore) {
      await this.catalogStore.close();
      this.catalogStore = null;
    }

    // Close the shared database manager
    await this.manager.close();
  }

  /**
   * Get the underlying IndexedDB manager for advanced operations.
   */
  getManager(): IndexedDBManager {
    return this.manager;
  }
}

/**
 * Create an IndexedDB provider with the given options.
 */
export function createIndexedDBProvider(options?: IndexedDBProviderOptions): IndexedDBProvider {
  return new IndexedDBProvider(options);
}

