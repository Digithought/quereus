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
import fs from 'node:fs';
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
	private storePaths = new Map<string, string>();
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
		const storePath = this.storePaths.get(storeName)
			?? path.join(this.basePath, schemaName, `${tableName}${STORE_SUFFIX.INDEX}${indexName}`);
		await this.closeStoreByName(storeName);
		await removeDir(storePath);
	}

	async renameTableStores(schemaName: string, oldName: string, newName: string): Promise<void> {
		const oldDataStoreName = `${schemaName}.${oldName}`.toLowerCase();
		const newDataStoreName = `${schemaName}.${newName}`.toLowerCase();

		if (this.stores.has(newDataStoreName)) {
			throw new Error(`Cannot rename '${oldName}' to '${newName}': store already open under the new name`);
		}

		// Close all open handles for the old table (data + indexes) so LevelDB
		// releases its file locks before we move the directories.
		await this.closeStoreByName(oldDataStoreName);

		const oldIndexPrefix = `${schemaName}.${oldName}${STORE_SUFFIX.INDEX}`.toLowerCase();
		const indexStoreNames: string[] = [];
		for (const name of this.stores.keys()) {
			if (name.startsWith(oldIndexPrefix)) indexStoreNames.push(name);
		}
		for (const name of indexStoreNames) {
			await this.closeStoreByName(name);
		}

		// Move data directory, if present.
		const schemaDir = path.join(this.basePath, schemaName);
		const oldDataPath = path.join(schemaDir, oldName);
		const newDataPath = path.join(schemaDir, newName);
		if (await pathExists(oldDataPath)) {
			if (await pathExists(newDataPath)) {
				throw new Error(`Cannot rename '${oldName}' to '${newName}': destination path '${newDataPath}' already exists`);
			}
			await fs.promises.rename(oldDataPath, newDataPath);
		}

		// Move each index directory under the new table name.
		const oldIndexDirPrefix = `${oldName}${STORE_SUFFIX.INDEX}`;
		try {
			const entries = await fs.promises.readdir(schemaDir);
			for (const entry of entries) {
				if (!entry.startsWith(oldIndexDirPrefix)) continue;
				const indexSuffix = entry.substring(oldIndexDirPrefix.length);
				const renamed = `${newName}${STORE_SUFFIX.INDEX}${indexSuffix}`;
				await fs.promises.rename(
					path.join(schemaDir, entry),
					path.join(schemaDir, renamed),
				);
			}
		} catch (e) {
			// readdir can fail if the schema directory doesn't exist (pre-creation);
			// that just means there's nothing to move.
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
		}
	}

	async deleteTableStores(schemaName: string, tableName: string): Promise<void> {
		// Close and remove data store directory
		const dataStoreName = `${schemaName}.${tableName}`.toLowerCase();
		const dataStorePath = this.storePaths.get(dataStoreName)
			?? path.join(this.basePath, schemaName, tableName);
		await this.closeStoreByName(dataStoreName);
		await removeDir(dataStorePath);

		// Stats are in the unified __stats__ store, so no need to close a separate store
		// The individual stats entry will be removed by the calling code if needed

		// Close and remove all index store directories for this table
		const indexPrefix = `${schemaName}.${tableName}${STORE_SUFFIX.INDEX}`.toLowerCase();
		const indexStoreNames: string[] = [];
		for (const name of this.stores.keys()) {
			if (name.startsWith(indexPrefix)) indexStoreNames.push(name);
		}
		for (const name of indexStoreNames) {
			const indexPath = this.storePaths.get(name);
			await this.closeStoreByName(name);
			if (indexPath) await removeDir(indexPath);
		}

		// Also sweep any on-disk index directories for this table that were never opened
		// in this session (e.g. after a process restart followed by a DROP).
		const schemaDir = path.join(this.basePath, schemaName);
		const indexDirPrefix = `${tableName}${STORE_SUFFIX.INDEX}`;
		try {
			const entries = await fs.promises.readdir(schemaDir);
			for (const entry of entries) {
				if (entry.startsWith(indexDirPrefix)) {
					await removeDir(path.join(schemaDir, entry));
				}
			}
		} catch {
			// Schema directory may not exist; nothing to sweep.
		}
	}

	private async getOrCreateStore(storeName: string, storePath: string): Promise<LevelDBStore> {
		let store = this.stores.get(storeName);

		if (!store) {
			store = await LevelDBStore.open({
				path: storePath,
				createIfMissing: this.createIfMissing,
			});
			this.stores.set(storeName, store);
			this.storePaths.set(storeName, storePath);
		}

		return store;
	}

	private async closeStoreByName(storeName: string): Promise<void> {
		const store = this.stores.get(storeName);
		if (store) {
			await store.close();
			this.stores.delete(storeName);
			this.storePaths.delete(storeName);
		}
	}
}

async function removeDir(dirPath: string): Promise<void> {
	await fs.promises.rm(dirPath, { recursive: true, force: true });
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.promises.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a LevelDB provider with the given options.
 */
export function createLevelDBProvider(options: LevelDBProviderOptions): LevelDBProvider {
	return new LevelDBProvider(options);
}
