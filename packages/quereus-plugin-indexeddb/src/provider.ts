/**
 * IndexedDB KVStore provider implementation.
 *
 * Uses a unified single-database architecture where all tables share one
 * IndexedDB database with multiple object stores (one per table).
 * This enables cross-table atomic transactions using native IDB transaction support.
 *
 * Storage naming convention:
 *   {schema}.{table}              - Data store (row data)
 *   {schema}.{table}_idx_{name}   - Index store (secondary indexes)
 *   __stats__                     - Unified stats store (row counts for all tables)
 *   __catalog__                   - Catalog store (DDL metadata)
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import {
	buildDataStoreName,
	buildIndexStoreName,
	CATALOG_STORE_NAME,
	STATS_STORE_NAME,
	STORE_SUFFIX,
} from '@quereus/store';
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
	private statsStore: IndexedDBStore | null = null;
	private manager: IndexedDBManager;

	constructor(options: IndexedDBProviderOptions = {}) {
		this.databaseName = options.databaseName ?? 'quereus';
		this.manager = IndexedDBManager.getInstance(this.databaseName);
	}

	async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
		const storeName = buildDataStoreName(schemaName, tableName);
		return this.getOrCreateStore(storeName);
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
		return this.getOrCreateStore(storeName);
	}

	async getStatsStore(_schemaName: string, _tableName: string): Promise<KVStore> {
		// Use the unified __stats__ store for all tables
		if (!this.statsStore) {
			this.statsStore = await IndexedDBStore.openForTable(
				this.databaseName,
				STATS_STORE_NAME
			);
		}
		return this.statsStore;
	}

	async getCatalogStore(): Promise<KVStore> {
		if (!this.catalogStore) {
			this.catalogStore = await IndexedDBStore.openForTable(
				this.databaseName,
				CATALOG_STORE_NAME
			);
		}
		return this.catalogStore;
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		const storeName = buildDataStoreName(schemaName, tableName);
		await this.closeStoreByName(storeName);
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
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

		// Close the shared database manager
		await this.manager.close();
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
		await this.closeStoreByName(storeName);
		await this.manager.deleteObjectStore(storeName);
	}

	async deleteTableStores(schemaName: string, tableName: string): Promise<void> {
		const dataStoreName = buildDataStoreName(schemaName, tableName);

		// Close and delete data store
		await this.closeStoreByName(dataStoreName);
		if (this.manager.hasObjectStore(dataStoreName)) {
			await this.manager.deleteObjectStore(dataStoreName);
		}

		// Stats are in the unified __stats__ store, so no need to delete a separate store
		// The individual stats entry will be removed by the calling code if needed

		// Find and delete all index stores for this table
		const indexPrefix = `${dataStoreName}${STORE_SUFFIX.INDEX}`;
		const allStores = this.manager.getObjectStoreNames();
		for (const name of allStores) {
			if (name.startsWith(indexPrefix)) {
				await this.closeStoreByName(name);
				await this.manager.deleteObjectStore(name);
			}
		}
	}

	/**
	 * Get the underlying IndexedDB manager for advanced operations.
	 */
	getManager(): IndexedDBManager {
		return this.manager;
	}

	private async getOrCreateStore(storeName: string): Promise<IndexedDBStore> {
		let store = this.stores.get(storeName);

		if (!store) {
			store = await IndexedDBStore.openForTable(this.databaseName, storeName);

			if (!store) {
				throw new Error(`IndexedDBStore.openForTable returned null/undefined for ${storeName}`);
			}

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
 * Create an IndexedDB provider with the given options.
 */
export function createIndexedDBProvider(options?: IndexedDBProviderOptions): IndexedDBProvider {
	return new IndexedDBProvider(options);
}
