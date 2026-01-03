/**
 * React Native LevelDB KVStore provider implementation.
 *
 * Manages LevelDB stores for the StoreModule in React Native environments.
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import { ReactNativeLevelDBStore, type LevelDBOpenFn, type LevelDBWriteBatchConstructor } from './store.js';

/**
 * Options for creating a React Native LevelDB provider.
 */
export interface ReactNativeLevelDBProviderOptions {
	/**
	 * The LevelDB open function from rn-leveldb.
	 * Obtain this from: import { LevelDB } from 'rn-leveldb';
	 * Then pass: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists)
	 */
	openFn: LevelDBOpenFn;

	/**
	 * The LevelDBWriteBatch constructor from rn-leveldb.
	 * Obtain this from: import { LevelDBWriteBatch } from 'rn-leveldb';
	 */
	WriteBatch: LevelDBWriteBatchConstructor;

	/**
	 * Base name prefix for all LevelDB databases.
	 * Each table gets a separate database with this prefix.
	 * @default 'quereus'
	 */
	databaseName?: string;

	/**
	 * Create databases if they don't exist.
	 * @default true
	 */
	createIfMissing?: boolean;
}

/**
 * React Native LevelDB implementation of KVStoreProvider.
 *
 * Creates separate LevelDB databases for each table. On mobile platforms,
 * this provides efficient, persistent key-value storage with sorted keys.
 */
export class ReactNativeLevelDBProvider implements KVStoreProvider {
	private openFn: LevelDBOpenFn;
	private WriteBatch: LevelDBWriteBatchConstructor;
	private databaseName: string;
	private createIfMissing: boolean;
	private stores = new Map<string, ReactNativeLevelDBStore>();
	private catalogStore: ReactNativeLevelDBStore | null = null;

	constructor(options: ReactNativeLevelDBProviderOptions) {
		this.openFn = options.openFn;
		this.WriteBatch = options.WriteBatch;
		this.databaseName = options.databaseName ?? 'quereus';
		this.createIfMissing = options.createIfMissing ?? true;
	}

	/**
	 * Get the database name for a table.
	 * Uses dots as separators for a flat namespace.
	 */
	private getDatabaseName(schemaName: string, tableName: string): string {
		return `${this.databaseName}.${schemaName}.${tableName}`.toLowerCase();
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
			const dbName = this.getDatabaseName(schemaName, tableName);
			store = ReactNativeLevelDBStore.open(this.openFn, this.WriteBatch, dbName, {
				createIfMissing: this.createIfMissing,
			});
			this.stores.set(key, store);
		}

		return store;
	}

	async getCatalogStore(): Promise<KVStore> {
		if (!this.catalogStore) {
			const catalogDbName = `${this.databaseName}.__catalog__`;
			this.catalogStore = ReactNativeLevelDBStore.open(this.openFn, this.WriteBatch, catalogDbName, {
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
 * Create a React Native LevelDB provider with the given options.
 */
export function createReactNativeLevelDBProvider(options: ReactNativeLevelDBProviderOptions): ReactNativeLevelDBProvider {
	return new ReactNativeLevelDBProvider(options);
}

