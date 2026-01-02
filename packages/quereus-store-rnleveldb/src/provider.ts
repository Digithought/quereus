import type { KVStore, KVStoreProvider } from '@quereus/plugin-store';
import { RNLevelDBStore } from './store.js';

export interface RNLevelDBProviderOptions {
  /**
   * Base name used to store all tables.
   *
   * `rn-leveldb` prefixes DB names with a platform document directory,
   * so this should be a relative prefix (no leading slash).
   *
   * Default recommendation: `quereus`
   */
  basePath: string;
}

export class RNLevelDBProvider implements KVStoreProvider {
  private readonly basePath: string;
  private readonly stores = new Map<string, RNLevelDBStore>();
  private readonly opening = new Map<string, Promise<RNLevelDBStore>>();
  private catalogStore: RNLevelDBStore | null = null;
  private openingCatalog: Promise<RNLevelDBStore> | null = null;

  constructor(options: RNLevelDBProviderOptions) {
    this.basePath = options.basePath;
  }

  private key(schemaName: string, tableName: string): string {
    return `${schemaName}.${tableName}`.toLowerCase();
  }

  private pathFor(schemaName: string, tableName: string): string {
    return formatDbName(this.basePath, schemaName, tableName);
  }

  async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
    const k = this.key(schemaName, tableName);
    const existing = this.stores.get(k);
    if (existing) return existing;

    const inflight = this.opening.get(k);
    if (inflight) return await inflight;

    const openPromise = RNLevelDBStore.open({ path: this.pathFor(schemaName, tableName), createIfMissing: true })
      .then((store) => {
        this.stores.set(k, store);
        return store;
      })
      .finally(() => {
        this.opening.delete(k);
      });

    this.opening.set(k, openPromise);
    return await openPromise;
  }

  async getCatalogStore(): Promise<KVStore> {
    if (this.catalogStore) return this.catalogStore;

    if (this.openingCatalog) return await this.openingCatalog;

    const openPromise = RNLevelDBStore.open({ path: formatCatalogDbName(this.basePath), createIfMissing: true })
      .then((store) => {
        this.catalogStore = store;
        return store;
      })
      .finally(() => {
        this.openingCatalog = null;
      });

    this.openingCatalog = openPromise;
    return await openPromise;
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
    this.opening.clear();
    if (this.catalogStore) {
      await this.catalogStore.close();
      this.catalogStore = null;
    }
    this.openingCatalog = null;
  }
}

export function createRNLevelDBProvider(options: RNLevelDBProviderOptions): RNLevelDBProvider {
  return new RNLevelDBProvider(options);
}

function formatCatalogDbName(basePath: string): string {
  return `${safeName(basePath)}__catalog__`;
}

function formatDbName(basePath: string, schemaName: string, tableName: string): string {
  return `${safeName(basePath)}__${safeName(schemaName)}__${safeName(tableName)}`;
}

function safeName(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
}


