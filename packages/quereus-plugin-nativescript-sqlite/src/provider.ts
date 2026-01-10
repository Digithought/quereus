/**
 * SQLite KVStore provider implementation for NativeScript.
 *
 * Manages SQLite-backed KV stores for the StoreModule.
 * Uses a single SQLite database with multiple tables (one per logical store).
 *
 * Storage naming convention:
 *   {prefix}{schema}_{table}              - Data store (row data)
 *   {prefix}{schema}_{table}_idx_{name}   - Index store (secondary indexes)
 *   {prefix}{schema}_{table}_stats        - Stats store (row count, etc.)
 *   {prefix}__catalog__                   - Catalog store (DDL metadata)
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import { STORE_SUFFIX } from '@quereus/store';
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
		return this.getOrCreateStore(key, this.getTableName(schemaName, tableName));
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		const key = `${this.getStoreKey(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`;
		const sqliteTableName = `${this.getTableName(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`.replace(/[^a-zA-Z0-9_]/g, '_');
		return this.getOrCreateStore(key, sqliteTableName);
	}

	async getStatsStore(schemaName: string, tableName: string): Promise<KVStore> {
		const key = `${this.getStoreKey(schemaName, tableName)}${STORE_SUFFIX.STATS}`;
		const sqliteTableName = `${this.getTableName(schemaName, tableName)}${STORE_SUFFIX.STATS}`.replace(/[^a-zA-Z0-9_]/g, '_');
		return this.getOrCreateStore(key, sqliteTableName);
	}

	async getCatalogStore(): Promise<KVStore> {
		if (!this.catalogStore) {
			this.catalogStore = SQLiteStore.create(this.db, `${this.tablePrefix}__catalog__`);
		}
		return this.catalogStore;
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		const key = this.getStoreKey(schemaName, tableName);
		await this.closeStoreByKey(key);
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const key = `${this.getStoreKey(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`;
		await this.closeStoreByKey(key);
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

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const key = `${this.getStoreKey(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`;
		await this.closeStoreByKey(key);
		// Note: SQLite doesn't need explicit store deletion - table is dropped when closed
	}

	async deleteTableStores(schemaName: string, tableName: string): Promise<void> {
		// Close data store
		const dataKey = this.getStoreKey(schemaName, tableName);
		await this.closeStoreByKey(dataKey);

		// Close stats store
		const statsKey = `${dataKey}${STORE_SUFFIX.STATS}`;
		await this.closeStoreByKey(statsKey);

		// Close all index stores for this table
		const indexPrefix = `${dataKey}${STORE_SUFFIX.INDEX}`;
		for (const [key, store] of this.stores) {
			if (key.startsWith(indexPrefix)) {
				await store.close();
				this.stores.delete(key);
			}
		}
	}

	private getOrCreateStore(key: string, sqliteTableName: string): SQLiteStore {
		let store = this.stores.get(key);

		if (!store) {
			store = SQLiteStore.create(this.db, sqliteTableName);
			this.stores.set(key, store);
		}

		return store;
	}

	private async closeStoreByKey(key: string): Promise<void> {
		const store = this.stores.get(key);
		if (store) {
			await store.close();
			this.stores.delete(key);
		}
	}
}

/**
 * Create a SQLite provider with the given options.
 */
export function createSQLiteProvider(options: SQLiteProviderOptions): SQLiteProvider {
	return new SQLiteProvider(options);
}
