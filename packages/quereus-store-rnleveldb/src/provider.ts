import type { KVStore, KVStoreProvider } from '@quereus/plugin-store';
import { RNLevelDBStore } from './store.js';

export interface RNLevelDBProviderOptions {
  /**
   * Base path used to store all tables.
   *
   * This should be an app-private directory (backed up by default):
   * - iOS: Library/Application Support/<bundle-id>/quereus
   * - Android: filesDir/quereus
   */
  basePath: string;
}

export class RNLevelDBProvider implements KVStoreProvider {
  private readonly basePath: string;
  private readonly stores = new Map<string, RNLevelDBStore>();
  private catalogStore: RNLevelDBStore | null = null;

  constructor(options: RNLevelDBProviderOptions) {
    this.basePath = options.basePath;
  }

  private key(schemaName: string, tableName: string): string {
    return `${schemaName}.${tableName}`.toLowerCase();
  }

  private pathFor(schemaName: string, tableName: string): string {
    // Defer exact path rules until we know what react-native-leveldb expects.
    return `${this.basePath}/${schemaName}/${tableName}`;
  }

  async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
    const k = this.key(schemaName, tableName);
    const existing = this.stores.get(k);
    if (existing) return existing;

    const store = await RNLevelDBStore.open({ path: this.pathFor(schemaName, tableName), createIfMissing: true });
    this.stores.set(k, store);
    return store;
  }

  async getCatalogStore(): Promise<KVStore> {
    if (this.catalogStore) return this.catalogStore;
    this.catalogStore = await RNLevelDBStore.open({ path: `${this.basePath}/__catalog__`, createIfMissing: true });
    return this.catalogStore;
  }

  async closeStore(schemaName: string, tableName: string): Promise<void> {
    const k = this.key(schemaName, tableName);
    const store = this.stores.get(k);
    if (!store) return;
    await store.close();
    this.stores.delete(k);
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

export function createRNLevelDBProvider(options: RNLevelDBProviderOptions): RNLevelDBProvider {
  return new RNLevelDBProvider(options);
}


