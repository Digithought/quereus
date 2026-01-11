/**
 * LevelDB KVStore provider implementation.
 *
 * Manages LevelDB stores for the StoreModule.
 *
 * Storage naming convention:
 *   {basePath}/{schema}/{table}              - Data store (row data)
 *   {basePath}/{schema}/{table}_idx_{name}   - Index store (secondary indexes)
 *   {basePath}/__stats__                     - Unified stats store (row counts for all tables)
 *   {basePath}/__catalog__                   - Catalog store (DDL metadata)
 */

import path from 'node:path';
import type { KVStore, KVStoreProvider } from '@quereus/store';
import { STORE_SUFFIX, CATALOG_STORE_NAME, STATS_STORE_NAME } from '@quereus/store';
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
	private statsStore: LevelDBStore | null = null;

	constructor(options: LevelDBProviderOptions) {
		this.basePath = options.basePath;
		this.createIfMissing = options.createIfMissing ?? true;
	}

	async getStore(schemaName: string, tableName: string, options?: Record<string, unknown>): Promise<KVStore> {
		const storeName = `${schemaName}.${tableName}`.toLowerCase();
		const storePath = (options?.path as string) || path.join(this.basePath, schemaName, tableName);
		return this.getOrCreateStore(storeName, storePath);
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		const storeName = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}${indexName}`.toLowerCase();
		const storePath = path.join(this.basePath, schemaName, `${tableName}${STORE_SUFFIX.INDEX}${indexName}`);
		return this.getOrCreateStore(storeName, storePath);
	}

	async getStatsStore(_schemaName: string, _tableName: string): Promise<KVStore> {
		// Use the unified __stats__ store for all tables
		if (!this.statsStore) {
			const statsPath = path.join(this.basePath, STATS_STORE_NAME);
			this.statsStore = await LevelDBStore.open({
				path: statsPath,
				createIfMissing: this.createIfMissing,
			});
		}
		return this.statsStore;
	}

	async getCatalogStore(): Promise<KVStore> {
		if (!this.catalogStore) {
			const catalogPath = path.join(this.basePath, CATALOG_STORE_NAME);
			this.catalogStore = await LevelDBStore.open({
				path: catalogPath,
				createIfMissing: this.createIfMissing,
			});
		}
		return this.catalogStore;
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		const storeName = `${schemaName}.${tableName}`.toLowerCase();
		await this.closeStoreByName(storeName);
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}${indexName}`.toLowerCase();
		await this.closeStoreByName(storeName);
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

		if (this.statsStore) {
			await this.statsStore.close();
			this.statsStore = null;
		}
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}${indexName}`.toLowerCase();
		await this.closeStoreByName(storeName);
		// Note: LevelDB doesn't have a built-in delete, would need fs.rm
		// For now, just close the store - actual deletion would require filesystem ops
	}

	async deleteTableStores(schemaName: string, tableName: string): Promise<void> {
		// Close data store
		const dataStoreName = `${schemaName}.${tableName}`.toLowerCase();
		await this.closeStoreByName(dataStoreName);

		// Stats are in the unified __stats__ store, so no need to close a separate store
		// The individual stats entry will be removed by the calling code if needed

		// Close all index stores for this table
		const indexPrefix = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}`.toLowerCase();
		for (const [name, store] of this.stores) {
			if (name.startsWith(indexPrefix)) {
				await store.close();
				this.stores.delete(name);
			}
		}

		// Note: Actual directory deletion would require filesystem operations
	}

	private async getOrCreateStore(storeName: string, storePath: string): Promise<LevelDBStore> {
		let store = this.stores.get(storeName);

		if (!store) {
			store = await LevelDBStore.open({
				path: storePath,
				createIfMissing: this.createIfMissing,
			});
			this.stores.set(storeName, store);
		}

		return store;
	}

	private async closeStoreByName(storeName: string): Promise<void> {
		const store = this.stores.get(storeName);
		if (store) {
			await store.close();
			this.stores.delete(storeName);
		}
	}
}

/**
 * Create a LevelDB provider with the given options.
 */
export function createLevelDBProvider(options: LevelDBProviderOptions): LevelDBProvider {
	return new LevelDBProvider(options);
}
