/**
 * SQLite KVStore provider implementation for NativeScript.
 *
 * Manages SQLite-backed KV stores for the StoreModule.
 * Uses a single SQLite database with multiple tables (one per logical store).
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import { SQLiteStore, type SQLiteDatabase } from './store.js';

/**
 * Options for creating a SQLite provider.
 */
export interface SQLiteProviderOptions {
  /**
   * The SQLite database instance.
   * Obtain this from @nativescript-community/sqlite's openOrCreate().
   */
  db: SQLiteDatabase;

  /**
   * Prefix for table names to avoid collisions.
   * @default 'quereus_'
   */
  tablePrefix?: string;
}

/**
 * SQLite implementation of KVStoreProvider for NativeScript.
 *
 * Creates separate tables for each logical store within a single SQLite database.
 * This is more efficient than multiple database files on mobile.
 */
export class SQLiteProvider implements KVStoreProvider {
  private db: SQLiteDatabase;
  private tablePrefix: string;
  private stores = new Map<string, SQLiteStore>();
  private catalogStore: SQLiteStore | null = null;

  constructor(options: SQLiteProviderOptions) {
    this.db = options.db;
    this.tablePrefix = options.tablePrefix ?? 'quereus_';
  }

  /**
   * Get the table name for a store.
   * Sanitizes schema/table names to valid SQLite identifiers.
   */
  private getTableName(schemaName: string, tableName: string): string {
    const sanitized = `${schemaName}_${tableName}`.replace(/[^a-zA-Z0-9_]/g, '_');
    return `${this.tablePrefix}${sanitized}`;
  }

  /**
   * Get the key for the store cache.
   */
  private getStoreKey(schemaName: string, tableName: string): string {
    return `${schemaName}.${tableName}`.toLowerCase();
  }

  async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
    const key = this.getStoreKey(schemaName, tableName);
    let store = this.stores.get(key);

    if (!store) {
      const sqliteTableName = this.getTableName(schemaName, tableName);
      store = SQLiteStore.create(this.db, sqliteTableName);
      this.stores.set(key, store);
    }

    return store;
  }

  async getCatalogStore(): Promise<KVStore> {
    if (!this.catalogStore) {
      this.catalogStore = SQLiteStore.create(this.db, `${this.tablePrefix}__catalog__`);
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

    // Close the underlying database
    this.db.close();
  }
}

/**
 * Create a SQLite provider with the given options.
 */
export function createSQLiteProvider(options: SQLiteProviderOptions): SQLiteProvider {
  return new SQLiteProvider(options);
}

