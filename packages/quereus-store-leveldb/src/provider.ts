/**
 * LevelDB KVStore provider implementation.
 *
 * Manages LevelDB stores for the StoreModule.
 */

import path from 'node:path';
import type { KVStore, KVStoreProvider } from 'quereus-plugin-store';
import { LevelDBStore } from './store.js';

/**
 * Options for creating a LevelDB provider.
 */
export interface LevelDBProviderOptions {
  /**
   * Base path for all LevelDB stores.
   * Each table gets a subdirectory under this path.
   */
  basePath: string;

  /**
   * Create directories if they don't exist.
   * @default true
   */
  createIfMissing?: boolean;
}

/**
 * LevelDB implementation of KVStoreProvider.
 *
 * Creates separate LevelDB databases for each table, stored
 * in subdirectories under the configured base path.
 */
export class LevelDBProvider implements KVStoreProvider {
  private basePath: string;
  private createIfMissing: boolean;
  private stores = new Map<string, LevelDBStore>();
  private catalogStore: LevelDBStore | null = null;

  constructor(options: LevelDBProviderOptions) {
    this.basePath = options.basePath;
    this.createIfMissing = options.createIfMissing ?? true;
  }

  /**
   * Get the storage path for a table.
   */
  private getStorePath(schemaName: string, tableName: string): string {
    return path.join(this.basePath, schemaName, tableName);
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
      // Use custom path if provided, otherwise use default
      const storePath = (options?.path as string) || this.getStorePath(schemaName, tableName);

      store = await LevelDBStore.open({
        path: storePath,
        createIfMissing: this.createIfMissing,
      });
      this.stores.set(key, store);
    }

    return store;
  }

  async getCatalogStore(): Promise<KVStore> {
    if (!this.catalogStore) {
      const catalogPath = path.join(this.basePath, '__catalog__');
      this.catalogStore = await LevelDBStore.open({
        path: catalogPath,
        createIfMissing: this.createIfMissing,
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
 * Create a LevelDB provider with the given options.
 */
export function createLevelDBProvider(options: LevelDBProviderOptions): LevelDBProvider {
  return new LevelDBProvider(options);
}

