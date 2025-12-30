/**
 * IndexedDB KVStore provider implementation.
 *
 * Manages IndexedDB stores for the StoreModule.
 */

import type { KVStore, KVStoreProvider } from 'quereus-plugin-store';
import { IndexedDBStore } from './store.js';

/**
 * Options for creating an IndexedDB provider.
 */
export interface IndexedDBProviderOptions {
  /**
   * Prefix for IndexedDB database names.
   * Each table gets its own IndexedDB database: `${prefix}_${schema}_${table}`.
   * @default 'quereus'
   */
  prefix?: string;
}

/**
 * IndexedDB implementation of KVStoreProvider.
 *
 * Creates separate IndexedDB databases for each table, using
 * a naming convention of `${prefix}_${schema}_${table}`.
 */
export class IndexedDBProvider implements KVStoreProvider {
  private prefix: string;
  private stores = new Map<string, IndexedDBStore>();
  private catalogStore: IndexedDBStore | null = null;

  constructor(options: IndexedDBProviderOptions = {}) {
    this.prefix = options.prefix ?? 'quereus';
  }

  /**
   * Get the database name for a table.
   */
  private getDatabaseName(schemaName: string, tableName: string): string {
    return `${this.prefix}_${schemaName}_${tableName}`;
  }

  /**
   * Get the key for the store cache.
   */
  private getStoreKey(schemaName: string, tableName: string): string {
    return `${schemaName}.${tableName}`.toLowerCase();
  }

  async getStore(schemaName: string, tableName: string, options?: Record<string, unknown>): Promise<KVStore> {
    const key = this.getStoreKey(schemaName, tableName);
    let store = this.stores.get(key);

    if (!store) {
      // Use custom path if provided (for backwards compatibility), otherwise use naming convention
      const dbName = (options?.path as string) || this.getDatabaseName(schemaName, tableName);

      store = await IndexedDBStore.open({
        path: dbName,
        createIfMissing: true,
      });
      this.stores.set(key, store);
    }

    return store;
  }

  async getCatalogStore(): Promise<KVStore> {
    if (!this.catalogStore) {
      const catalogDbName = `${this.prefix}__catalog__`;
      this.catalogStore = await IndexedDBStore.open({
        path: catalogDbName,
        createIfMissing: true,
      });
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
  }
}

/**
 * Create an IndexedDB provider with the given options.
 */
export function createIndexedDBProvider(options?: IndexedDBProviderOptions): IndexedDBProvider {
  return new IndexedDBProvider(options);
}

